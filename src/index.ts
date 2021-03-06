/**
 * @author    Martin Micunda {@link https://schedulino.com}
 * @copyright Copyright (c) 2016, Schedulino ltd.
 * @license   MIT
 */
import Boom from '@hapi/boom';
import AWS, { AWSError, DynamoDB } from 'aws-sdk';
import { ConfigurationOptions } from 'aws-sdk/lib/config';
import { DocumentClient } from 'aws-sdk/lib/dynamodb/document_client';
import { PromiseResult } from 'aws-sdk/lib/request';
import https from 'https';
import { LambdaLog } from 'lambda-log';
import { v1, v4 } from 'uuid';

export const uuidV1 = v1;
export const uuidV4 = v4;

export interface CreateItemOutput {
  id?: string;
  created?: string;
  updated?: string;
}

export interface UpdateItemOutput {
  id?: string;
  updated?: string;
}

export type PutItemInput = DocumentClient.PutItemInput;
export type QueryInput = DocumentClient.QueryInput;
export type GetItemInput = DocumentClient.GetItemInput;
export type UpdateItemInput = DocumentClient.UpdateItemInput;
export type Key = DocumentClient.Key;
export type Schema =
  | { [key: string]: DocumentClient.AttributeValue }
  | undefined;

const logger = new LambdaLog({
  debug: process.env.LOGGER_LEVEL === 'DEBUG',
});
/**
 * default keep-alive - https://hackernoon.com/lambda-optimization-tip-enable-http-keep-alive-6dc503f6f114
 * https://theburningmonk.com/2019/02/lambda-optimization-tip-enable-http-keep-alive/
 *
 * this should become default in aws-sdk-js v3 https://github.com/aws/aws-sdk-js/pull/2595
 */
const sslAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: true,
});
// @ts-ignore
sslAgent.setMaxListeners(0);

/**
 * An adapter class for dealing with a DynamoDB.
 */
export class DynamoDBAdapter {
  readonly tableName: string;
  readonly schema: Schema;

  private readonly db: DynamoDB;
  private readonly doc: DocumentClient;

  static config(options: ConfigurationOptions) {
    AWS.config.update({
      region: options.region,
      httpOptions: { agent: sslAgent },
    });
  }

  static model(tableName: string, schema?: Schema) {
    return new DynamoDBAdapter(tableName, schema);
  }

  private static handleError(error: AWSError): Boom {
    let dbError;

    switch (error.name) {
      case 'NotFound':
        dbError = Boom.notFound('Requested resource not found.');
        break;
      case 'ConditionalCheckFailedException':
        dbError = Boom.conflict('Requested resource already exists.');
        break;
      default:
        dbError = Boom.badImplementation(
          'Something went wrong with DB server.'
        );
    }

    return dbError;
  }

  private static projectionExpression(
    fields: DocumentClient.ProjectionExpression = ''
  ):
    | {
        ProjectionExpression: DocumentClient.ProjectionExpression;
        ExpressionAttributeNames: DocumentClient.ExpressionAttributeNameMap;
      }
    | undefined {
    const fieldsObj = fields.split(',');
    if (!Array.isArray(fieldsObj)) {
      return;
    }

    let i = 0;
    const projectionExpression: {
      ProjectionExpression: DocumentClient.ProjectionExpression;
      ExpressionAttributeNames: DocumentClient.ExpressionAttributeNameMap;
    } = {
      ProjectionExpression: '',
      ExpressionAttributeNames: {},
    };

    fieldsObj.forEach(field => {
      if (i === 0) {
        projectionExpression.ProjectionExpression += `#${field}`;
      } else {
        projectionExpression.ProjectionExpression += `, #${field}`;
      }
      projectionExpression.ExpressionAttributeNames[`#${field}`] = field;
      i += 1;
    });

    return projectionExpression;
  }

  constructor(tableName: string, schema?: Schema) {
    // depends on serverless-offline plugion which adds IS_OFFLINE to process.env when running offline
    const options = {
      region: 'localhost',
      endpoint: 'http://localhost:8000',
    };

    this.db = process.env.IS_OFFLINE
      ? new DynamoDB(options)
      : new DynamoDB({ httpOptions: { agent: sslAgent } });
    this.doc = new DynamoDB.DocumentClient({
      service: this.db,
      httpOptions: { agent: sslAgent },
    });
    this.tableName = tableName;
    this.schema = schema;
  }

  listTables(
    params: DocumentClient.ListTablesInput = {}
  ): Promise<PromiseResult<DocumentClient.ListTablesOutput, AWSError>> {
    return this.db.listTables(params).promise();
  }

  createTable(
    params: DocumentClient.CreateTableInput
  ): Promise<PromiseResult<DocumentClient.CreateTableOutput, AWSError>> {
    return this.db.createTable(params).promise();
  }

  deleteTable(
    params: DocumentClient.DeleteTableInput
  ): Promise<PromiseResult<DocumentClient.DeleteTableOutput, AWSError>> {
    return this.db.deleteTable(params).promise();
  }

  async findOne<T>(
    key: DocumentClient.Key,
    originParams?: DocumentClient.GetItemInput
  ): Promise<T> {
    logger.debug(
      `DB_ACTION::get TABLE::${this.tableName} ACCOUNT::${key.accountId} ID::${key.id}`
    );
    let params = originParams;
    if (params && params.ProjectionExpression) {
      params = {
        ...params,
        ...DynamoDBAdapter.projectionExpression(params.ProjectionExpression),
      };
    }

    try {
      const data = await this.doc
        .get({
          ...params,
          TableName: this.tableName,
          Key: key,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();
      // throw 404 if item doesn't exist
      if (data.Item) {
        return data.Item as T;
      }
    } catch (error) {
      logger.error(
        `DB_ACTION::get TABLE::${this.tableName} ACCOUNT::${key.accountId} ID::${key.id}`,
        error.message
      );
      throw error;
    }

    const error = DynamoDBAdapter.handleError({ name: 'NotFound' } as AWSError);
    logger.error(
      `DB_ACTION::get TABLE::${this.tableName} ACCOUNT::${key.accountId} ID::${key.id} ${error.message}`
    );

    throw error;
  }

  async find<T>(originParams: DocumentClient.QueryInput): Promise<T[]> {
    logger.debug(
      `DB_ACTION::query TABLE::${this.tableName} ACCOUNT::${
        originParams.ExpressionAttributeValues
          ? originParams.ExpressionAttributeValues[':accountId']
          : ''
      }`
    );
    let params = originParams;
    if (params && params.ProjectionExpression) {
      params = {
        ...params,
        ...DynamoDBAdapter.projectionExpression(params.ProjectionExpression),
      };
    }

    try {
      const data = await this.doc
        .query({
          ...params,
          TableName: this.tableName,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();
      logger.debug(`Count ${data.Count}`);
      logger.debug(`ScannedCount ${data.ScannedCount}`);
      logger.debug('ConsumedCapacity', data.ConsumedCapacity);
      return (data.Items || []) as T[];
    } catch (error) {
      logger.error(
        `DB_ACTION::query TABLE::${this.tableName} ACCOUNT::${
          params.ExpressionAttributeValues
            ? params.ExpressionAttributeValues[':accountId']
            : ''
        }`,
        error.message
      );
      throw DynamoDBAdapter.handleError(error);
    }
  }

  async create(
    item: DocumentClient.PutItemInput,
    itemId?: string
  ): Promise<CreateItemOutput> {
    const id = itemId || uuidV1();
    logger.debug(
      `DB_ACTION::create TABLE::${this.tableName} ACCOUNT::${item.Item.accountId} ID::${id}`
    );

    if (this.schema && this.schema.id) {
      item.Item.id = id;
    }
    if (this.schema && this.schema.created) {
      item.Item.created = new Date().toISOString();
    }
    if (this.schema && this.schema.updated) {
      if (item.Item.created) {
        item.Item.updated = item.Item.created;
      } else {
        item.Item.updated = new Date().toISOString();
      }
    }
    try {
      await this.doc
        .put({
          ...item,
          TableName: this.tableName,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();

      const respondData: CreateItemOutput = {};
      if (this.schema && this.schema.id) {
        respondData.id = item.Item.id;
      }
      if (this.schema && this.schema.updated) {
        respondData.updated = item.Item.updated;
      }
      if (this.schema && this.schema.created) {
        respondData.created = item.Item.created;
      }

      return respondData;
    } catch (error) {
      logger.error(
        `DB_ACTION::create TABLE::${this.tableName} ACCOUNT::${item.Item.accountId} ID::${id}`,
        error.message
      );
      throw DynamoDBAdapter.handleError(error);
    }
  }

  async update(item: DocumentClient.PutItemInput): Promise<UpdateItemOutput> {
    logger.debug(
      `DB_ACTION::update TABLE::${this.tableName} ACCOUNT::${item.Item.accountId} ID::${item.Item.id}`
    );

    if (this.schema && this.schema.updated) {
      item.Item.updated = new Date().toISOString();
    }

    try {
      await this.doc
        .put({
          ...item,
          TableName: this.tableName,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();

      const respondData: UpdateItemOutput = {};
      if (this.schema && this.schema.updated) {
        respondData.updated = item.Item.updated;
      }

      return respondData;
    } catch (error) {
      logger.error(
        `DB_ACTION::update TABLE::${this.tableName} ACCOUNT::${item.Item.accountId} ID::${item.Item.id}`,
        error.message
      );
      throw DynamoDBAdapter.handleError(error);
    }
  }

  async updateWithAttributes(
    originParams: DocumentClient.UpdateItemInput,
    item: DocumentClient.PutItemInputAttributeMap
  ): Promise<UpdateItemOutput> {
    logger.debug(
      `DB_ACTION::updateAttributes TABLE::${this.tableName} ACCOUNT::${originParams.Key.accountId} ID::${originParams.Key.id}`
    );

    if (this.schema && this.schema.updated) {
      item.updated = new Date().toISOString();
    }

    const keys = Object.keys(originParams.Key);
    keys.forEach(k => {
      if (item[k]) {
        delete item[k];
      }
    });
    const params = {
      ...{
        UpdateExpression: '',
        ExpressionAttributeNames: {},
        ExpressionAttributeValues: {},
      },
      ...originParams,
      TableName: this.tableName,
    };

    let i = 0;
    let set = 0;
    let remove = 0;
    let UpdateExpressionSetAction = ' ';
    let UpdateExpressionRemoveAction = ' ';

    Object.keys(item).forEach(valueKey => {
      i += 1;
      if (params.ExpressionAttributeNames) {
        params.ExpressionAttributeNames[`#param${i}`] = valueKey;
      }
      // update an attribute
      if (item[valueKey] !== '' && params.ExpressionAttributeValues) {
        set += 1;
        params.ExpressionAttributeValues[`:val${i}`] = item[valueKey];
        UpdateExpressionSetAction +=
          set === 1 ? `SET #param${i} = :val${i}` : `, #param${i} = :val${i}`;
      } else {
        // delete an attribute
        remove += 1;
        UpdateExpressionRemoveAction +=
          remove === 1 ? `REMOVE #param${i}` : `, #param${i}`;
      }
    });

    if (set === 0) {
      delete params.ExpressionAttributeValues;
    }
    params.UpdateExpression +=
      UpdateExpressionSetAction + UpdateExpressionRemoveAction;

    try {
      await this.doc.update(params).promise();

      const respondData: UpdateItemOutput = {};
      if (this.schema && this.schema.updated) {
        respondData.updated = item.updated;
      }
      // required for batch update e.g. publish shifts
      respondData.id = originParams.Key.id;

      return respondData;
    } catch (error) {
      logger.error(
        `DB_ACTION::updateAttributes TABLE::${this.tableName} ACCOUNT::${originParams.Key.accountId} ID::${originParams.Key.id}`,
        error.message
      );
      throw DynamoDBAdapter.handleError(error);
    }
  }

  async destroy(key: DocumentClient.Key): Promise<void> {
    logger.debug(
      `DB_ACTION::delete TABLE::${this.tableName} ACCOUNT::${key.accountId} ID::${key.id}`
    );

    try {
      await this.doc
        .delete({
          Key: key,
          TableName: this.tableName,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();
      return;
    } catch (error) {
      logger.error(
        `DB_ACTION::delete TABLE::${this.tableName} ACCOUNT::${key.accountId} ID::${key.id}`,
        error.message
      );
      throw DynamoDBAdapter.handleError(error);
    }
  }

  async destroyBatch<T>(
    items: T[],
    accountId: string,
    rangeKey = 'id',
    hashKey = 'accountId'
  ) {
    logger.debug(
      `DB_ACTION::destroyAll TABLE::${this.tableName} ACCOUNT::${accountId}`
    );
    const chunkSize = 25; // which can comprise as many as 25 delete requests
    const arraysOf25Items = this.chunk<T>(items, chunkSize);

    const deleteParams = arraysOf25Items.map((array: T[]) => ({
      RequestItems: {
        [this.tableName]: array.map(item => ({
          DeleteRequest: {
            // tslint:disable-next-line
            Key: { [hashKey]: accountId, [rangeKey]: (item as any)[rangeKey] },
          },
        })),
      },
    }));

    try {
      for (const deleteParam of deleteParams) {
        await this.batchWrite(deleteParam, accountId);
      }
    } catch (error) {
      logger.error(
        `DB_ACTION::destroyAll TABLE::${this.tableName} ACCOUNT::${accountId}`,
        error.message
      );
      throw error;
    }
  }

  async batchWrite(
    params: DocumentClient.BatchWriteItemInput,
    accountId: string
  ): Promise<DocumentClient.BatchWriteItemOutput> {
    logger.debug(
      `DB_ACTION::batchWrite TABLE::${this.tableName} ACCOUNT::${accountId}`
    );

    try {
      return this.doc.batchWrite(params).promise();
    } catch (error) {
      logger.error(
        `DB_ACTION::batchWrite TABLE::${this.tableName} ACCOUNT::${accountId}`,
        error.message
      );
      throw error;
    }
  }

  async scan(
    originParams: DocumentClient.ScanInput
  ): Promise<DocumentClient.ItemList | undefined> {
    logger.debug(`DB_ACTION::scan TABLE::${this.tableName}`);

    try {
      const data = await this.doc
        .scan({
          ...originParams,
          TableName: this.tableName,
          ReturnConsumedCapacity: 'INDEXES',
        })
        .promise();

      return data.Items;
    } catch (error) {
      logger.error(`DB_ACTION::scan TABLE::${this.tableName}`, error.message);
      throw error;
    }
  }

  private chunk<T>(array: T[], size: number): T[][] {
    return array
      .map(({}, i: number) =>
        i % size === 0 ? array.slice(i, i + size) : null
      )
      .filter((e: T[] | null) => !!e) as T[][];
  }
}
