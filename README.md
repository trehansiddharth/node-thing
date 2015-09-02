# node-thing

Introduction
------------

node-thing is a node.js that offers a centralized way to handle communication between devices for Internet of Things applications.

node-thing is based on an Internet of Things architecture consisting of a central Mongo database and several devices that can connect to the database to report their status, receive queries, and send commands for other devices to process. This choice of highly centralized architecture makes it easy to add, remove, or update devices without worrying about which connections will have to be added or will be broken. Additionally, the use of MongoDB to store device data makes information updates and access fast, secure, reliable, and scalable.

node-thing classifies all interactions between devices as one of two types: the retrieval of information or the execution of commands and queries. There is overlap between these two categories where one device runs a query on another device to retrieve some information from it, but the difference lies in which device initiates the action -- in the former case, a device passively receives all information being published by another device, while in the latter, a device will initiate the query by specifying what information it wants or what action it wants executed. This device communcation model therefore consists of two parts:

* The `status` pattern. A device will continuously publish information about its status in the format of a limited set of properties. A printer, for example, might publish the `toner_level` property, whose value is the amount of toner remaining, as well as the `is_printing` property, which is a boolean set to `true` when the printer is currently printing. Other devices can subscribe to individual properties and receive updates when they are changed so they can immediately respond to that change in device status.

* The `queries` pattern. These are commands that are sent from one device to another which can optionally return a result back to the first device. For instance, a phone might send a `play` command to a music player or a `search` query to find all songs containing a particular keyword.

In both cases, under the hood, the node-thing package is sending data back and forth between the devices and the centralized database, but the library abstracts this away so that it looks like data is being exchanged directly between the devices.

Setup
-----

First, ensure that you have MongoDB set up somewhere that grants you admin access to it (note: MongoLabs does not, and most hosting services that offer this require paid subscriptions). node-thing requires access to an oplog for every collection where devices are pushing or subscribing to data. The oplog is created on a separate database on the same machine (the local database, which requires admin access to modify), and can be set up by following the instructions given [here](https://tuttlem.github.io/2014/06/13/how-to-setup-an-oplog-on-a-single-mongodb-instance.html).

You will need to create two collections for each device, one for data related to device status, and one for data related to device queries. Start by picking a unique `$DEVICE_NAME` for each device. The names of the collections are given by appending a suffix to the `$DEVICE_NAME`. By default, the former collection is called `$DEVICE_NAME_status`, and the latter is called `$DEVICE_NAME_queries`. Create these two collections for each device that you want on the network. If you want to use suffixes other than `_status` and `_queries`, you can do that when you load the node.js module, described later in the documentation. Once you have created these collections, ensure the oplog is available for each of these.

Finally, you may want to consider adding different database users for each device to be more secure with information exchanges across devices. If there is an untrusted device on your network, if permissions for accessing each collection are not properly set up, it will be able to read all information from all devices on your network and be able to execute queries and commands on them. For more information on setting up permissions to prevent these sorts of scenarios, see [here](http://docs.mongodb.org/manual/core/collection-level-access-control/).

Installation
------------

Install the node-thing package using npm:

```
npm install node-thing
```

The dependencies for node-thing, which should be installed automatically, are:

* mongodb: ~2.0
* mongo-oplog: ~0.1.6
* log4js: ~0.6
* events: ~1.0

Documentation
-------------

Start by importing the node-thing module:

```javascript
var thing = require("node-thing");
```

Configure the parameters of the `thing` so that once it will be started correctly. The parameters that can be configured are:

* `thing.configuration.mongoUri`: URI to identify the MongoDB server where all data lives (e.g. "mongodb://fred:foobar@localhost"). Do not include the name of a database. Not set by default.

* `thing.configuration.databaseName`: Name of the database on the server where device data should be, and where all the collections corresponding to the device data are. Not set by default.

* `thing.configuration.oplogName`: Name of the database on the server where the oplog data is. This database is usually called "local", so by default it is set to `"local"`.

* `thing.configuration.thingName`: Name of the device that the node.js application should be handling. node-thing will allow your application to push updates and resolve queries on this device. You do not have to set this parameter if you do not plan on pushing updates or resolving queries by running `thing.start()`. Not set by default.

* `thing.configuration.queries_suffix`: Suffix on the collection handling device queries. By default, it is set to `"_queries"`.

* `thing.configuration.status_suffix`: Suffix on the collection handling device status. By default, it is set to `"_status"`.

You can view or modify the configuration by using the `thing.configuration` variable directly, but an easier way to change the configuration would be to use the `thing.configure()` function:

```javascript
thing.configure({
    mongoUri : "...",
    databaseName : "...",
    thingName : "...",
    ...
});
```

Next, connect to the database by running `thing.connect()`, which is an asynchronous function:

```javascript
thing.connect(function (err) {
    if (err) {
        throw err;
    } else {
        // continue here...
    }
});
```

Once the connection is made, you can start listening to incoming queries and start pushing updates by running `thing.start()`, which is also asynchronous:

```javascript
thing.start(function (err) {
    if (err) {
        throw err;
    } else {
        // Now you can communicate with other devices
        // by publishing status and executing their queries ...
    }
});
```

Now, you can update the status of your device using `thing.updateStatus()`:

```javascript
thing.updateStatus("name_of_property", "new_value_of_property", function (err, result) {
    if (err) {
        throw err;
    } else {
        console.log("Updated status successfully!");
    }
});
```

Note: the name of the property does not necessarily have to be a string, it can be an arbitrary EJSONable value.

You can also get the status of your device that you have published by using `thing.getStatus()`:

```javascript
// Get the entire status (fetch all properties)
thing.getStatus(null, function (err, status) {
    if (err) {
        throw err;
    } else {
        console.log("The complete status is:");
        console.log(status);
    }
});

// Get the value of a specific property from the status
thing.getStatus("property_name", function (err, value) {
    if (err) {
        throw err;
    } else {
        console.log("The value of property_name is %s.", value);
    }
});
```

Lastly, you can create functions that will handle different types of queries:

```javascript
thing.onQuery("name_of_query", function (argument_1, argument_2, ..., callback) {
    // Run query and get result, if applicable
    var result = ...;
    // Run callback to inform the other device that the action
    // has been completed and to return the result, if applicable.
    // If there is no useful result, run callback(null), or else
    // the other device may be left waiting.
    callback(result);
});
```

Often, your device will want to communicate with other devices. To do this, we will first create an object to represent the device (which we will call a "sentinel" for that device), and then use that object to communicate with that other device. First, we create a sentinel using `thing.sentinel()`, also an asynchronous function:

```javascript
thing.sentinel("other_device_name", function (err, other_device) {
    if (err) {
        throw err;
    } else {
        // do stuff with other_device...
    }
});
```

We can get the status of the other device by using `other_device.getStatus()`:

```javascript
// Get the entire status of the other device (fetch all properties)
other_device.getStatus(null, function (err, status) {
    if (err) {
        throw err;
    } else {
        console.log("The complete status of the other device is:");
        console.log(status);
    }
});

// Get the value of a specific property from the status
// of ther other device
other_device.getStatus("property_name", function (err, value) {
    if (err) {
        throw err;
    } else {
        console.log("The value of property_name is %s.", value);
    }
});
```

We can also subscribe to the status of the other device -- whenever the status of the other device is updated, we will be notified. To do this, use the `thing.subscribe()` function:

```javascript
// Get updates to a specific property
other_device.subscribe("property_name", function (value) {
    console.log("The value of property_name is now %s", value);
});

// Alternatively, receive updates whenever ANY property is updated.
// This is useful when a device is constantly pushing new data as
// part of its status, e.g., a phone pushing all of its new
// notifications onto its status.
other_device.subscribe(null, function (property, value) {
    console.log("The value of %s is now %s.", property, value);
});
```

Finally, we can also query the other device by using the `other_device.query()` function:

```javascript
other_device.query("query_name", "argument_1", "argument_2", callback(err, result) {
    if (err) {
        throw err;
    } else {
        console.log("The query was run and the following result was received:");
        console.log(result);
    }
});
```

Note: though the name of the query must be a string, the arguments can be arbitrary EJSONable values.

Examples
--------

There aren't currently any real-world projects using node-thing, but I'm working on rewriting my music-control and h32missioncontrol projects (which can be found on my github) to use node-thing.
