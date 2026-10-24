
const express = require('express');
const { MongoClient } = require('mongodb')
const app = express();
const port = 5000;
require('dotenv').config()
app.get('/', (req, res) => {
    res.send('Hello World!');
});





const client = new MongoClient(process.env.URI);
async function connectToMongoDB() {
    try {






        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
connectToMongoDB()



app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});