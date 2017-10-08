import * as mongodb from 'mongodb';
import {MongoClient} from 'mongodb'
import RawSchemaBatch from '../../models/rawSchema/rawSchemaBatch';
import RawSchemaProcessWorker from '../../helpers/rawSchema/rawSchemaProcessWorker';
import DatabaseParam from '../../params/databaseParam';
import BaseController from '../base';
import RawSchemaController from './rawSchema';
import RawSchemaOrderedResultController from './rawSchemaOrderedResult';
import RawSchemaUnorderedResultController from './rawSchemaUnorderedResult';
import RawSchemaUnionController from './rawSchemaUnion';
import JsonSchemaExtractedController from '../jsonSchema/jsonSchemaExtracted';
import AlertController from '../alert/alert'

export default class RawSchemaBatchController extends BaseController {
  
  model = RawSchemaBatch;

  allSteps = (params): Promise<any> => {
    return new Promise((resolv, reject) => {
      
      const databaseParam = new DatabaseParam(JSON.parse(JSON.stringify(params)));
      const rawSchemaBatch = new this.model();
      rawSchemaBatch.collectionName = databaseParam.collectionName;
      rawSchemaBatch.dbUri = databaseParam.getURIWithoutAuthentication();
      rawSchemaBatch.userId = databaseParam.userId;
      rawSchemaBatch.startDate = new Date();
      rawSchemaBatch.status = "CONNECT_DATABASE";
      rawSchemaBatch.save().then((data) => {
        return this.connect(databaseParam);  
      }).then((data) => {
        return this.getCollection(data, rawSchemaBatch);
      }).then((data) => {
        return this.executeStepOne(data, rawSchemaBatch);
      }).then((data) => {
        return this.executeStepTwo(rawSchemaBatch);
      }).then((data) => {
        return this.executeStepThree(rawSchemaBatch);
      }).then((data) => {
        return this.executeStepFour(rawSchemaBatch);
      }).then((data) => {
        return this.generateAlert(data);
      }).then((data) => {
        return resolv(data);
      }).catch((error) => {
        console.log("error",error)
        if(rawSchemaBatch){  
          rawSchemaBatch.status = "ERROR";
          rawSchemaBatch.statusType = error.type;
          rawSchemaBatch.statusMessage = error.message;
          rawSchemaBatch.save().then((data) => {
            return this.generateAlert(rawSchemaBatch);
          }).then((data) => {
            return resolv(data);
          }).catch((error) => {
            return reject(error);
          });
        } else {
          return reject(error);
        }
      });
    });
  }
  
  deleteBatch = (batchId): Promise<any> => {
    return new Promise((resolv, reject) => {
      this.model.findOneAndRemove({ _id: batchId }).then((data) =>{
        return new RawSchemaController().deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return new RawSchemaOrderedResultController().deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return new RawSchemaUnorderedResultController(batchId).deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return new RawSchemaUnionController().deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return new JsonSchemaExtractedController().deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return new AlertController().deleteEntitiesByBatchId(batchId);
      }).then((data) => {
        return resolv(data);
      }).catch((error) => {
        return reject(error);
      });
    });
  }

  discovery = (params): Promise<any> => {
    return new Promise((resolv, reject) => {
      
      const databaseParam = new DatabaseParam(JSON.parse(JSON.stringify(params)));
      const rawSchemaBatch = new this.model();
      rawSchemaBatch.collectionName = databaseParam.collectionName;
      rawSchemaBatch.dbUri = databaseParam.getURIWithoutAuthentication();
      rawSchemaBatch.userId = databaseParam.userId;
      rawSchemaBatch.startDate = new Date();

      this.connect(databaseParam).then((data) => {
        return this.getCollection(data, rawSchemaBatch);
      }).then((data) => {
        return this.executeStepOne(data, rawSchemaBatch);
      }).then((data) => {
        return resolv(data);
      }).catch((error) => {
        if(rawSchemaBatch){  
          rawSchemaBatch.status = "ERROR";
          rawSchemaBatch.statusMessage = error;
          rawSchemaBatch.save();
        } else {
          return reject(error);
        }
      });
    });
  }

  private connect = (databaseParam): Promise<any> => {
    return new Promise((resolv, reject) => {
      MongoClient.connect(databaseParam.getURI(), { connectTimeoutMS: 5000 }).then((database) => {
        return resolv(database);
      }).catch((error) => {
        return reject({"type":"DATABASE_CONNECTION_ERROR", "message": error.message, "code":400});
      });
    });
  }

  private getCollection = (database, rawSchemaBatch): Promise<any> => {
    return new Promise((resolv, reject) => {
      const collection = database.collection(rawSchemaBatch.collectionName);
      collection.count().then((count) => {
        if(count === 0)
          return reject({"type":"EMPTY_COLLECTION_ERROR", "message": "coleção não encontrada", "code":400});
        rawSchemaBatch.collectionCount = count;
        rawSchemaBatch.status = "LOADING_DOCUMENTS";
        return rawSchemaBatch.save();
      }).then((data) => {
        return resolv(collection);
      }).catch((error) => {
        return reject({"type":"EMPTY_COLLECTION_ERROR", "message": "coleção não encontrada", "code":400});
      });
    });
  }

  private executeStepOne = (collection, rawSchemaBatch): Promise<any> => {
    return new Promise((resolv, reject) => {
      const worker = new RawSchemaProcessWorker();
      const saver = new RawSchemaController();
      worker.work(rawSchemaBatch, collection, null)
        .on('done',() => {
          rawSchemaBatch.status = "REDUCE_DOCUMENTS";
          rawSchemaBatch.extractionDate = new Date();
          rawSchemaBatch.save().then((data) => {
            return resolv(data);
          }).catch((error) => {
            return reject({"type":"LOADING_DOCUMENTS_ERROR", "message": error.message, "code":400});
          });
        })
        .on('error', (error) => {
          return reject({"type":"LOADING_DOCUMENTS_ERROR", "message": error.message, "code":400});
        })
        .on('lastObjectId', (lastObjectId) => {
          worker.work(rawSchemaBatch, collection, lastObjectId);
        })
        .on('save', (rawSchemes) => {
          saver.saveAll(rawSchemes, rawSchemaBatch._id);
        });
    });
  }

  private executeStepTwo = (rawSchemaBatch) => {
    return this.aggregateAndReduce(rawSchemaBatch._id);
  }

  private executeStepThree = (rawSchemaBatch) => {
    return new RawSchemaOrderedResultController().union(rawSchemaBatch._id);
  }

  private executeStepFour = (rawSchemaBatch) => {
    return new JsonSchemaExtractedController().generate(rawSchemaBatch._id);
  }

  private generateAlert = (rawSchemaBatch) => {
    return new AlertController().generate(rawSchemaBatch);
  }

  mapReduce = (batchId): Promise<any> => {
    return new Promise((resolv, reject) => {
      let rawSchemaBatch;
      this.getById(batchId).then((rawSchemaBatchResult) => {
        if (!rawSchemaBatchResult)
          return reject({"message":`rawSchemaBatch with id: ${batchId} not found`, "code":404});
        return rawSchemaBatchResult;
      }).then((data) => {
        rawSchemaBatch = data;
        rawSchemaBatch.reduceType = "MAP_REDUCE";
        rawSchemaBatch.unorderedMapReduceDate = null;
        rawSchemaBatch.orderedMapReduceDate = null;
        rawSchemaBatch.unorderedAggregationDate = null;
        rawSchemaBatch.orderedAggregationDate = null;
        return new RawSchemaController().mapReduce(batchId);
      }).then((data) => {
        return  new RawSchemaUnorderedResultController(batchId).saveResults(data, batchId);
      }).then((data) => {
        rawSchemaBatch.unorderedMapReduceDate = new Date();
        rawSchemaBatch.save();
        return new RawSchemaUnorderedResultController(batchId).mapReduce(batchId);
      }).then((data) => {
        return new RawSchemaOrderedResultController().saveResults(data, batchId);
      }).then((data) => {
        rawSchemaBatch.status = "UNION_DOCUMENTS";
        rawSchemaBatch.orderedMapReduceDate = new Date();
        rawSchemaBatch.save();
        return resolv(data);
      }).catch((error) => {
        return reject({"type":"REDUCE_DOCUMENTS_ERROR", "message": error.message, "code":400});
      });
    });
  }

  aggregate = (batchId): Promise<any> => {
    return new Promise((resolv, reject) => {
      let rawSchemaBatch;
      this.getById(batchId).then((rawSchemaBatchResult) => {
        if (!rawSchemaBatchResult)
          return reject({"message":`rawSchemaBatch with id: ${batchId} not found`, "code":404});
        return rawSchemaBatchResult;
      }).then((data) => {
        rawSchemaBatch = data;
        rawSchemaBatch.reduceType = "AGGREGATE";
        rawSchemaBatch.unorderedMapReduceDate = null;
        rawSchemaBatch.orderedMapReduceDate = null;
        rawSchemaBatch.unorderedAggregationDate = null;
        rawSchemaBatch.orderedAggregationDate = null;
        return new RawSchemaController().aggregate(batchId);
      }).then((data) => {
        rawSchemaBatch.unorderedAggregationDate = new Date();
        rawSchemaBatch.save();
        return new RawSchemaUnorderedResultController(batchId).aggregate(batchId);
      }).then((data) => {
        return new RawSchemaOrderedResultController().saveResults(data, batchId);
      }).then((data) => {
        rawSchemaBatch.status = "UNION_DOCUMENTS";
        rawSchemaBatch.orderedAggregationDate = new Date();
        rawSchemaBatch.save();
        return resolv(data);
      }).catch((error) => {
        return reject({"type":"REDUCE_DOCUMENTS_ERROR", "message": error.message, "code":400});
      });
    });
  }

  aggregateAndReduce = (batchId): Promise<any> => {
    return new Promise((resolv, reject) => {
      let rawSchemaBatch;
      this.getById(batchId).then((rawSchemaBatchResult) => {
        if (!rawSchemaBatchResult)
          return reject({"message":`rawSchemaBatch with id: ${batchId} not found`, "code":404});
        return rawSchemaBatchResult;
      }).then((data) => {
        rawSchemaBatch = data;
        rawSchemaBatch.reduceType = "AGGREGATE_AND_MAP_REDUCE";
        rawSchemaBatch.unorderedMapReduceDate = null;
        rawSchemaBatch.orderedMapReduceDate = null;
        rawSchemaBatch.unorderedAggregationDate = null;
        rawSchemaBatch.orderedAggregationDate = null;
        return new RawSchemaController().aggregate(batchId);
      }).then((data) => {
        rawSchemaBatch.unorderedAggregationDate = new Date();
        rawSchemaBatch.save();
        return new RawSchemaUnorderedResultController(batchId).mapReduce(batchId);
      }).then((data) => {
        return new RawSchemaOrderedResultController().saveResults(data, batchId);
      }).then((data) => {
        rawSchemaBatch.status = "UNION_DOCUMENTS";
        rawSchemaBatch.orderedMapReduceDate = new Date();
        rawSchemaBatch.save();
        return resolv(rawSchemaBatch);
      }).catch((error) => {
        return reject({"type":"REDUCE_DOCUMENTS_ERROR", "message": error.message, "code":400});
      });
    });
  }

  getById = (id) => {
  	return this.model.findById(id);
  }

  listByUserId = (userId) => {
    return this.model.find({"userId":userId});
  }

}
