"use strict";


var mongo   = require("mongodb"),                       // to store updates from devices
    oplog   = require("mongo-oplog"),                   // to receive update events from MongoDB
    logger  = require("log4js").getLogger("thing"),     // to log errors, warnings, debug info, etc. to the console
    events  = require("events");                        // to create event handlers for updates


exports.configuration = {
    mongoUri : null,                                    // URI to identify the MongoDB database server where all data lives
    databaseName : null,                                // name of the database on the server where queries and status data live
    oplogName : "local",                                // name of the database on the server where the oplogs live
    thingName : null,                                   // name of the thing being handled
    queries_suffix : "_queries",                        // suffix to append to device name to get name of queries collection
    status_suffix : "_status"                           // suffix to append to device name to get name of status collection
};

exports.objects = {
    db : null,                                          // database object used to run queries
    event_emitter : null,                               // event emitter used to handle queries on the thing
    device_queries_collection : null,                   // collection object used to run queries on device queries collection
    device_status_collection : null                     // collection object used to run queries on device status collection
};


exports.configure = function (customConfiguration) {
    for (var attribute in customConfiguration) {
        if (attribute in exports.configuration) {
            exports.configuration[attribute] = customConfiguration[attribute];
        } else {
            logger.warn("The attribute %s is not a configurable property.", attribute);
        }
    }
};

exports.connect = function (callback) {
    // Connect to the mongo database at configuration.mongoUri
    var fullMongoUri = exports.configuration.mongoUri + "/" + exports.configuration.databaseName;
    mongo.MongoClient.connect(fullMongoUri, function (err, db) {
        if (err) {
            logger.error("Error while establishing connection to the mongo database.");
            logger.error("configuration.mongoUri: %s", exports.configuration.mongodbUri)
            logger.error(err);
            callback(err);
        } else {
            logger.trace("Connection established.");
            exports.objects.db = db;
            callback(null);
        }
    })
};

exports.getCollections = function (thingName, callback) {
    // Check to make sure thingName has been set
    if (thingName) {
        // Check to make sure a connection to the database has already been made
        if (exports.objects.db) {
            // Get the collection containing device queries
            var device_queries_name = thingName + exports.configuration.queries_suffix;
            exports.objects.db.collection(device_queries_name, function (err, device_queries_collection) {
                if (err) {
                    logger.error("Could not get the device_queries collection. Did you create the collection?");
                    logger.error("Collection name: %s", device_queries_name);
                    callback(err, null);
                } else {
                    // Get the collection containing device status
                    var device_status_name = thingName + exports.configuration.status_suffix;
                    exports.objects.db.collection(device_status_name, function (err, device_status_collection) {
                        if (err) {
                            logger.error("Could not get the device_status collection. Did you create the collection?");
                            logger.error("Collection name: %s", device_status_name);
                            callback(err, null);
                        } else {
                            callback(null, device_queries_collection, device_status_collection);
                        }
                    });
                }
            });
        } else {
            logger.error("Could not get the db object. Did you run connect()?");
            callback(new Error("could not get db object"), null);
        }
    } else {
        logger.error("Could not get the thingName. Did you run configure() to set thingName?");
        callback(new Error("could not get thingName"), null);
    }
};

exports.start = function (callback) {
    // Get the queries and updates collections for the thing
    var thingName = exports.configuration.thingName;
    exports.getCollections(thingName, function (err, device_queries_collection, device_status_collection) {
        if (err) {
            callback(err, null);
        } else {
            // Save the collections into exports.objects
            exports.objects.device_queries_collection = device_queries_collection;
            exports.objects.device_status_collection = device_status_collection;

            // Create a new event emitter to handle events for the thing
            exports.objects.event_emitter = new events.EventEmitter();

            // Subscribe to the oplog for the device queries collection
            var fullOplogUri = exports.configuration.mongoUri + "/" + exports.configuration.oplogName;
            var fullDeviceQueriesName = exports.configuration.databaseName + "." + thingName + exports.configuration.queries_suffix;
            var device_queries_oplog = oplog(fullOplogUri, fullDeviceQueriesName).tail();

            // Create hooks from the oplog to the thing to handle queries appropriately
            device_queries_oplog.on("insert", function (data) {
                var query = data.o;
                if (data.o.waiting) {
                    exports.objects.event_emitter.emit(query.query, query._id, query.arguments);
                }
            });
            device_queries_oplog.on("update", function (data) {
                var id = data.o2._id;
                device_queries_collection.findOne({ _id : id }, function (err, query) {
                    if (err) {
                        logger.error("Update event from oplog does not correspond to an existing document.");
                    } else {
                        if (query.waiting) {
                            exports.objects.event_emitter.emit(query.query, id, query.arguments);
                        }
                    }
                });
            });
            callback(null);
        }
    });
};

exports.validateStarted = function (callback) {
    if (exports.objects.event_emitter && exports.objects.device_queries_collection && exports.objects.device_status_collection){
        callback();
    } else {
        logger.error("The appropriate objects were not found. Did you run start()?");
    }
};

exports.updateStatus = function (property, value, callback) {
    exports.validateStarted(function () {
        exports.objects.device_status_collection.findOne({ property : property }, function (err, result) {
            if (err) {
                logger.error("Error while trying to access collection for updating.");
                callback(err, null);
            } else if (result) {
                var update = { value : value, lastModified : new Date() };
                exports.objects.device_status_collection.updateMany({ property : property }, { $set : update }, callback);
            } else {
                var document = { property : property, value : value, lastModified: new Date() };
                exports.objects.device_status_collection.insert(document, callback);
            }
        });
    });
};

exports.onQuery = function (query, callback) {
    exports.validateStarted(function () {
        exports.objects.event_emitter.on(query, function (id, query_arguments) {
            var fullArguments = query_arguments.concat(function (result) {
                var update = { result : result, waiting : false, lastModified : new Date() };
                exports.objects.device_queries_collection.updateOne({ _id : id }, { $set : update }, { $upsert : true }, function (err) {
                    if (err) {
                        logger.error("Error while updating the device queries collection for query %s on thing %s.", query, thingName);
                    }
                });
            })
            callback.apply(null, fullArguments);
        });
    });
};

exports.getStatus = function (property, callback) {
    exports.validateStarted(function () {
        if (property) {
            exports.objects.device_status_collection.findOne({ property : property }, function (err, data) {
                if (err) {
                    logger.error("Error getting the status for property %s. Most likely this property does not exist.", property);
                    callback(err, null);
                } else if (!data) {
                    callback(null, null)
                } else {
                    callback(null, data.value);
                }
            });
        } else {
            exports.objects.device_status_collection.find({}).toArray(function (err, data) {
                if (err) {
                    logger.error("Error getting the status for all properties.");
                    callback(err, null);
                } else {
                    callback(null, data);
                }
            });
        }
    });
};

exports.sentinel = function (sentinelName, callback) {
    // Get the queries and updates collections for the sentinel
    exports.getCollections(sentinelName, function (err, device_queries_collection, device_status_collection) {
        if (err) {
            callback(err, null);
        } else {
            // Create a sentinel object to store information about the thing being connected to
            var sentinel = {
                device_queries_collection : device_queries_collection,
                device_status_collection : device_status_collection
            }

            // Create a new event emitter to handle events for the thing
            sentinel.event_emitter = new events.EventEmitter();

            // Subscribe to the oplogs for the device queries and device status collections
            var fullOplogUri = exports.configuration.mongoUri + "/" + exports.configuration.oplogName;
            var fullDeviceQueriesName = exports.configuration.databaseName + "." + sentinelName + exports.configuration.queries_suffix;
            var fullDeviceStatusName = exports.configuration.databaseName + "." + sentinelName + exports.configuration.status_suffix;
            var device_queries_oplog = oplog(fullOplogUri, fullDeviceQueriesName).tail();
            var device_status_oplog = oplog(fullOplogUri, fullDeviceStatusName).tail();

            // Create hooks from the oplog to the sentinel to receive query results correctly
            device_queries_oplog.on("insert", function (data) {
                var query = data.o;
                if (!query.waiting) {
                    sentinel.event_emitter.emit("queries_" + query._id, query.result);
                }
            });
            device_queries_oplog.on("update", function (data) {
                var id = data.o2._id;
                sentinel.device_queries_collection.findOne({ _id : id }, function (err, query) {
                    if (err) {
                        logger.error("Update event from oplog does not correspond to an existing document.");
                    } else {
                        if (!query.waiting) {
                            sentinel.event_emitter.emit("queries_" + query._id, query.result);
                        }
                    }
                });
            });

            // Create hooks from the oplog to the thing to receive updates to device status appropriately
            device_status_oplog.on("insert", function (data) {
                var item = data.o;
                sentinel.event_emitter.emit("status_" + item._id, item.value);
                sentinel.event_emitter.emit("new_or_updated", item);
            });
            device_status_oplog.on("update", function (data) {
                var id = data.o2._id;
                sentinel.device_status_collection.findOne({ _id : id }, function (err, item) {
                    if (err || !item) {
                        logger.error("Update event from oplog does not correspond to an existing document.");
                    } else {
                        sentinel.event_emitter.emit("status_" + id, item.value);
                        sentinel.event_emitter.emit("new_or_updated", item);
                    }
                });
            });

            // Create a function for sending queries to the device
            sentinel.query = function () {
                var args = [].slice.call(arguments);
                var query = {};
                query.query = args[0];
                query.arguments = args.slice(1, args.length - 1);
                query.waiting = true;
                query.result = null;
                query.lastModified = new Date();
                var callback = args[args.length - 1];
                sentinel.device_queries_collection.insert(query, function (err, result) {
                    if (err) {
                        logger.error("Error while running query %s.", query.query);
                        callback(err, null);
                    } else {
                        sentinel.event_emitter.on("queries_" + query._id, function (result) {
                            callback(null, result);
                        });
                    }
                });
            };

            // Create a function for getting device status
            sentinel.getStatus = function (property, callback) {
                if (property) {
                    sentinel.device_status_collection.findOne({ property : property }, function (err, data) {
                        if (err) {
                            logger.error("Error getting the status for property %s. Most likely this property does not exist.", property);
                            callback(err, null);
                        } else if (!data) {
                            callback(null, null);
                        } else {
                            callback(null, data.value);
                        }
                    });
                } else {
                    sentinel.device_status_collection.find({}).toArray(function (err, data) {
                        if (err) {
                            logger.error("Error getting the status for all properties.");
                            callback(err, null);
                        } else {
                            callback(null, data);
                        }
                    });
                }
            };

            // Create a function for subscribing to a property of the device status or additions to the device status
            sentinel.subscribe = function (property, callback) {
                if (property) {
                    sentinel.device_status_collection.findOne({ property : property }, function (err, data) {
                        if (err) {
                            logger.error("Error getting the status for property %s. Most likely this property does not exist.", property);
                        } else {
                            sentinel.event_emitter.on("status_" + data._id, callback);
                        }
                    });
                } else {
                    sentinel.event_emitter.on("new_or_updated", function (item) {
                        callback(item.property, item.value);
                    });
                }
            };

            // Return the sentinel
            callback(null, sentinel);
        }
    });
};
