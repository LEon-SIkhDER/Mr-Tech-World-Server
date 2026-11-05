const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const app = express();
const port = 5000;
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Enable CORS for frontend client communication and parse incoming JSON request bodies
app.use(express.json());
app.use(cors());

// Server health check route
app.get('/', (req, res) => {
    res.send('Hello World! Mr. Tech World API is running.');
});

const client = new MongoClient(process.env.URI);

async function connectToMongoDB() {
    try {
        const db = client.db("Mr_Tech_World");
        const categoryCollection = db.collection("categories");
        const productCollection = db.collection("products");
        const purchaseCollection = db.collection("purchases");
        const supplierCollection = db.collection("suppliers");

        // ====================================================================================================
        // * ------------------------------------ CATEGORY APIs (categories) ------------------------------------
        // ====================================================================================================

        // GET /categories -> Retrieve all category documents from the categories collection
        app.get("/categories", async (req, res) => {
            try {
                const result = await categoryCollection.find().toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching categories:", err);
                res.status(500).send({ message: "Failed to fetch categories" });
            }
        });

        // GET /categories/names -> Retrieve category names and IDs only (lightweight for dropdown select menus)
        app.get("/categories/names", async (req, res) => {
            try {
                const projection = { projection: { name: 1 } };
                const result = await categoryCollection.find({}, projection).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching category names:", err);
                res.status(500).send({ message: "Failed to fetch category names" });
            }
        });

        // POST /category -> Create and save a new category document with server timestamps
        app.post("/category", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();
                data.updatedAt = new Date();
                const result = await categoryCollection.insertOne(data);
                res.send(result);
            } catch (err) {
                console.error("Error creating category:", err);
                res.status(500).send({ message: "Failed to create category" });
            }
        });

        // ====================================================================================================
        // * ------------------------------------ PRODUCT APIs (products) ---------------------------------------
        // ====================================================================================================

        app.get("/product/variants/:id", async (req, res) => {
            const { id } = req.params
            const query = { _id: new ObjectId(id) }
            const projection = {
                projection: {
                    _id: 0,
                    variantAttributes: 1
                }
            }
            const result = await productCollection.findOne(query, projection)
            res.send(result)

        })

        // GET /products-name-id -> Retrieve product names and IDs only for search comboboxes and selection inputs
        app.get("/products-name-id", async (req, res) => {
            try {
                const projection = { projection: { name: 1 } };
                const result = await productCollection.find({}, projection).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching products name and ID:", err);
                res.status(500).send({ message: "Failed to fetch products" });
            }
        });

        // GET /product/:id -> Retrieve complete single product details by product ObjectId
        app.get("/product/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID format" });
                }
                const query = { _id: new ObjectId(id) };
                const result = await productCollection.findOne(query);
                if (!result) {
                    return res.status(404).send({ message: "Product not found" });
                }
                res.send(result);
            } catch (err) {
                console.error("Error fetching product by ID:", err);
                res.status(500).send({ message: "Failed to fetch product" });
            }
        });

        // GET /product/:id/combinations -> Retrieve variant combinations, attributes, and IMEI configurations by product ID
        app.get("/product/:id/combinations", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID" });
                }
                const query = { _id: new ObjectId(id) };
                const projection = {
                    projection: {
                        name: 1,
                        hasImei: 1,
                        variantTypes: 1,
                        variants: 1,
                        warranty: 1,
                        brand: 1,
                        model: 1
                    }
                };
                const product = await productCollection.findOne(query, projection);
                if (!product) {
                    return res.status(404).send({ message: "Product not found" });
                }
                res.send({
                    productId: product._id,
                    name: product.name,
                    hasImei: Boolean(product.hasImei),
                    variantTypes: product.variantTypes || [],
                    variants: product.variants || []
                });
            } catch (err) {
                console.error("Error fetching product combinations:", err);
                res.status(500).send({ message: "Failed to fetch combinations" });
            }
        });

        // GET /products/:id/combinations -> Redirect alias pointing to /product/:id/combinations for route compatibility
        app.get("/products/:id/combinations", async (req, res) => {
            res.redirect(307, `/product/${req.params.id}/combinations`);
        });

        // POST /product -> Insert a new product into the catalog with server timestamps
        app.post("/product", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();
                data.updatedAt = new Date();
                const result = await productCollection.insertOne(data);
                res.send(result);
            } catch (err) {
                console.error("Error creating product:", err);
                res.status(500).send({ message: "Failed to create product" });
            }
        });

        // ====================================================================================================
        // * ------------------------------------ PURCHASE APIs (purchases) -------------------------------------
        // ====================================================================================================

        // GET /purchases -> Retrieve all purchase inventory transactions and invoice records
        app.get("/purchases", async (req, res) => {
            try {
                const result = await purchaseCollection.find().toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching purchases:", err);
                res.status(500).send({ message: "Failed to fetch purchases" });
            }
        });

        // POST /purchase -> Record a new stock purchase and merge variant stock + IMEIs into the product collection
        app.post("/purchase", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();
                data.updatedAt = new Date();

                // 1. Save the purchase record as an audit log
                const result = await purchaseCollection.insertOne(data);

                // 2. Merge purchased variants into the product collection (live stock source of truth)
                const productId = data.productId;
                const purchasedVariants = Array.isArray(data.variants) ? data.variants : [];

                if (productId && ObjectId.isValid(productId) && purchasedVariants.length > 0) {
                    const productQuery = { _id: new ObjectId(productId) };
                    const product = await productCollection.findOne(productQuery);

                    if (product) {
                        const existingVariants = Array.isArray(product.variants) ? product.variants : [];
                        const updatedVariants = [...existingVariants];

                        for (const incoming of purchasedVariants) {
                            const incomingTitle = (incoming.title || "").trim().toLowerCase();
                            const incomingBarcode = (incoming.barcode || "").trim().toLowerCase();

                            // Match existing variant by title or barcode
                            const matchIndex = updatedVariants.findIndex((v) => {
                                const titleMatch = incomingTitle && (v.title || "").trim().toLowerCase() === incomingTitle;
                                const barcodeMatch = incomingBarcode && (v.barcode || "").trim().toLowerCase() === incomingBarcode;
                                return titleMatch || barcodeMatch;
                            });

                            if (matchIndex !== -1) {
                                // Variant already exists -> add qty and merge new IMEIs
                                const existing = updatedVariants[matchIndex];
                                const mergedImeis = Array.from(new Set([
                                    ...(Array.isArray(existing.imeis) ? existing.imeis : []),
                                    ...(Array.isArray(incoming.imeis) ? incoming.imeis : [])
                                ]));
                                updatedVariants[matchIndex] = {
                                    ...existing,
                                    quantity: (Number(existing.quantity) || 0) + (Number(incoming.quantity) || 0),
                                    purchasePrice: Number(incoming.purchasePrice) || existing.purchasePrice || 0,
                                    retailPrice: Number(incoming.retailPrice) || existing.retailPrice || 0,
                                    mrp: Number(incoming.mrp) || existing.mrp || 0,
                                    barcode: incoming.barcode || existing.barcode || "",
                                    imeis: mergedImeis,
                                    updatedAt: new Date()
                                };
                            } else {
                                // Brand new variant -> push it into the product variants array
                                updatedVariants.push({
                                    title: incoming.title || "",
                                    combination: Array.isArray(incoming.combination) ? incoming.combination : [],
                                    attributes: Array.isArray(incoming.attributes) ? incoming.attributes : [],
                                    barcode: incoming.barcode || "",
                                    purchasePrice: Number(incoming.purchasePrice) || 0,
                                    retailPrice: Number(incoming.retailPrice) || 0,
                                    mrp: Number(incoming.mrp) || 0,
                                    quantity: Number(incoming.quantity) || 0,
                                    imeis: Array.isArray(incoming.imeis) ? incoming.imeis : [],
                                    createdAt: new Date(),
                                    updatedAt: new Date()
                                });
                            }
                        }

                        // Sync hasImei flag on the product if this purchase tracks IMEIs
                        const hasImeiUpdate = data.hasImei === true ? { hasImei: true } : {};

                        await productCollection.updateOne(productQuery, {
                            $set: {
                                variants: updatedVariants,
                                ...hasImeiUpdate,
                                updatedAt: new Date()
                            }
                        });
                    }
                }

                res.send(result);
            } catch (err) {
                console.error("Error creating purchase:", err);
                res.status(500).send({ message: "Failed to create purchase" });
            }
        });

        // ====================================================================================================
        // * ------------------------------------ SUPPLIER APIs (suppliers) -------------------------------------
        // ====================================================================================================

        // GET /suppliers -> Retrieve all registered suppliers with complete contact and address details
        app.get("/suppliers", async (req, res) => {
            try {
                const result = await supplierCollection.find().toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching suppliers:", err);
                res.status(500).send({ message: "Failed to fetch suppliers" });
            }
        });

        // GET /suppliers/names -> Retrieve supplier names and IDs only (lightweight for purchase dropdown menus)
        app.get("/suppliers/names", async (req, res) => {
            try {
                const projection = { projection: { name: 1 } };
                const result = await supplierCollection.find({}, projection).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching supplier names:", err);
                res.status(500).send({ message: "Failed to fetch supplier names" });
            }
        });

        // POST /supplier -> Create and store a new supplier profile with contact details
        app.post("/supplier", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();
                data.updatedAt = new Date();
                const result = await supplierCollection.insertOne(data);
                res.send(result);
            } catch (err) {
                console.error("Error creating supplier:", err);
                res.status(500).send({ message: "Failed to create supplier" });
            }
        });

        // PUT /supplier/:id -> Update an existing supplier profile by supplier ObjectId
        app.put("/supplier/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid supplier ID format" });
                }
                const data = req.body;
                const query = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        name: data.name,
                        phone: data.phone,
                        contactPerson: data.contactPerson,
                        address: data.address,
                        email: data.email,
                        notes: data.notes,
                        updatedAt: new Date()
                    }
                };
                const result = await supplierCollection.updateOne(query, updateDoc);
                res.send(result);
            } catch (err) {
                console.error("Error updating supplier:", err);
                res.status(500).send({ message: "Failed to update supplier" });
            }
        });

        // DELETE /supplier/:id -> Permanently remove a supplier profile by supplier ObjectId
        app.delete("/supplier/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid supplier ID format" });
                }
                const query = { _id: new ObjectId(id) };
                const result = await supplierCollection.deleteOne(query);
                res.send(result);
            } catch (err) {
                console.error("Error deleting supplier:", err);
                res.status(500).send({ message: "Failed to delete supplier" });
            }
        });

        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.error("MongoDB connection error:", err);
    }
}

connectToMongoDB();

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
