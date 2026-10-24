const express = require('express');
const { MongoClient } = require('mongodb')
const cors = require('cors');
const app = express();
const port = 5000;
const dns = require("node:dns")
dns.setServers(["8.8.8.8", "8.8.4.4"])
require('dotenv').config()
app.use(express.json())
app.use(cors())
app.get('/', (req, res) => {
    res.send('Hello World!');
});

const client = new MongoClient(process.env.URI);
async function connectToMongoDB() {
    try {
        const db = client.db("Mr_Tech_World")
        const categoryCollection = db.collection("categories")
        const productCollection = db.collection("products")

        app.get("/categories", async(req,res)=>{
            const result = await categoryCollection.find().toArray()
            res.send(result)
        })

        app.post("/category", async (req, res) => {
            const data = req.body
            data.createdAt = new Date()
            data.updatedAt = new Date()
            const result = await categoryCollection.insertOne(data)
            res.send(result)
        })

        app.get("/products", async (req, res) => {
            const result = await productCollection.find().toArray()
            res.send(result)
        })

        app.post("/product", async (req, res) => {
            const data = req.body
            data.createdAt = new Date()
            data.updatedAt = new Date()
            const result = await productCollection.insertOne(data)
            res.send(result)
        })

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
