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
        // ------------------------------------ CATEGORY APIs (categories) ------------------------------------
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
        // ------------------------------------ PRODUCT APIs (products) ---------------------------------------
        // ====================================================================================================

        // GET /products -> Aggregated lightweight product list with variants count, stock, and price ranges
        app.get("/products", async (req, res) => {
            try {
                const pipeline = [
                    // 1. Lookup purchases from purchaseCollection (matching by ObjectId or String)
                    {
                        $lookup: {
                            from: "purchases",
                            let: { productIdStr: { $toString: "$_id" }, productIdObj: "$_id" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $eq: ["$productId", "$$productIdStr"] },
                                                { $eq: ["$productId", "$$productIdObj"] },
                                                { $eq: [{ $toString: "$productId" }, "$$productIdStr"] }
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "purchases"
                        }
                    },

                    // 2. Lookup category name from categories collection by category ID
                    {
                        $lookup: {
                            from: "categories",
                            let: {
                                catIdStr: { $toString: { $ifNull: ["$category", ""] } },
                                rawCategory: "$category"
                            },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $eq: [{ $toString: "$_id" }, "$$catIdStr"] },
                                                { $eq: ["$_id", "$$rawCategory"] },
                                                { $eq: ["$name", "$$catIdStr"] }
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "categoryDoc"
                        }
                    },

                    // 3. Resolve category name and category ID fields, and flatten variants from all purchases
                    {
                        $addFields: {
                            category: { $ifNull: ["$category", ""] },
                            categoryId: { $ifNull: ["$category", ""] },
                            categoryName: {
                                $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, "Uncategorized"]
                            },
                            "category name": {
                                $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, "Uncategorized"]
                            },
                            category_name: {
                                $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, "Uncategorized"]
                            },
                            allPurchaseVariants: {
                                $reduce: {
                                    input: "$purchases.variants",
                                    initialValue: [],
                                    in: { $concatArrays: ["$$value", { $ifNull: ["$$this", []] }] }
                                }
                            }
                        }
                    },

                    // 4. Source of variants: purchase collection if available, fallback to product.variants
                    {
                        $addFields: {
                            activeVariants: {
                                $cond: [
                                    { $gt: [{ $size: "$allPurchaseVariants" }, 0] },
                                    "$allPurchaseVariants",
                                    { $ifNull: ["$variants", []] }
                                ]
                            }
                        }
                    },

                    // 5. Unique variant combinations/titles, total stock, and in-stock variants
                    {
                        $addFields: {
                            uniqueVariantTitles: {
                                $setUnion: [
                                    {
                                        $map: {
                                            input: "$activeVariants",
                                            as: "v",
                                            in: {
                                                $ifNull: [
                                                    "$$v.title",
                                                    {
                                                        $reduce: {
                                                            input: { $ifNull: ["$$v.combination", []] },
                                                            initialValue: "",
                                                            in: {
                                                                $cond: [
                                                                    { $eq: ["$$value", ""] },
                                                                    "$$this",
                                                                    { $concat: ["$$value", " / ", "$$this"] }
                                                                ]
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    },
                                    []
                                ]
                            },
                            totalStock: {
                                $reduce: {
                                    input: "$activeVariants",
                                    initialValue: 0,
                                    in: {
                                        $add: [
                                            "$$value",
                                            { $toDouble: { $ifNull: ["$$this.quantity", 0] } }
                                        ]
                                    }
                                }
                            },
                            inStockVariants: {
                                $filter: {
                                    input: "$activeVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.quantity", 0] } }, 0] }
                                }
                            }
                        }
                    },

                    // 6. Filter prices for in-stock items (quantity > 0) vs all variants
                    {
                        $addFields: {
                            inStockPurchasePriced: {
                                $filter: {
                                    input: "$inStockVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.purchasePrice", 0] } }, 0] }
                                }
                            },
                            allPurchasePriced: {
                                $filter: {
                                    input: "$activeVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.purchasePrice", 0] } }, 0] }
                                }
                            },
                            inStockRetailPriced: {
                                $filter: {
                                    input: "$inStockVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.retailPrice", 0] } }, 0] }
                                }
                            },
                            allRetailPriced: {
                                $filter: {
                                    input: "$activeVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.retailPrice", 0] } }, 0] }
                                }
                            },
                            inStockMrpPriced: {
                                $filter: {
                                    input: "$inStockVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.mrp", 0] } }, 0] }
                                }
                            },
                            allMrpPriced: {
                                $filter: {
                                    input: "$activeVariants",
                                    as: "v",
                                    cond: { $gt: [{ $toDouble: { $ifNull: ["$$v.mrp", 0] } }, 0] }
                                }
                            }
                        }
                    },

                    // 7. Prioritize in-stock price range, fall back to all if out of stock
                    {
                        $addFields: {
                            targetPurchasePriced: {
                                $cond: [
                                    { $gt: [{ $size: "$inStockPurchasePriced" }, 0] },
                                    "$inStockPurchasePriced",
                                    "$allPurchasePriced"
                                ]
                            },
                            targetRetailPriced: {
                                $cond: [
                                    { $gt: [{ $size: "$inStockRetailPriced" }, 0] },
                                    "$inStockRetailPriced",
                                    "$allRetailPriced"
                                ]
                            },
                            targetMrpPriced: {
                                $cond: [
                                    { $gt: [{ $size: "$inStockMrpPriced" }, 0] },
                                    "$inStockMrpPriced",
                                    "$allMrpPriced"
                                ]
                            }
                        }
                    },

                    // 8. Compute min and max values
                    {
                        $addFields: {
                            minPurchasePrice: {
                                $cond: [
                                    { $gt: [{ $size: "$targetPurchasePriced" }, 0] },
                                    { $min: "$targetPurchasePriced.purchasePrice" },
                                    0
                                ]
                            },
                            maxPurchasePrice: {
                                $cond: [
                                    { $gt: [{ $size: "$targetPurchasePriced" }, 0] },
                                    { $max: "$targetPurchasePriced.purchasePrice" },
                                    0
                                ]
                            },
                            minRetailPrice: {
                                $cond: [
                                    { $gt: [{ $size: "$targetRetailPriced" }, 0] },
                                    { $min: "$targetRetailPriced.retailPrice" },
                                    0
                                ]
                            },
                            maxRetailPrice: {
                                $cond: [
                                    { $gt: [{ $size: "$targetRetailPriced" }, 0] },
                                    { $max: "$targetRetailPriced.retailPrice" },
                                    0
                                ]
                            },
                            minMrp: {
                                $cond: [
                                    { $gt: [{ $size: "$targetMrpPriced" }, 0] },
                                    { $min: "$targetMrpPriced.mrp" },
                                    0
                                ]
                            },
                            maxMrp: {
                                $cond: [
                                    { $gt: [{ $size: "$targetMrpPriced" }, 0] },
                                    { $max: "$targetMrpPriced.mrp" },
                                    0
                                ]
                            },
                            variantsCount: { $size: "$uniqueVariantTitles" }
                        }
                    },

                    // 9. Format range objects and extract first image string URL
                    {
                        $addFields: {
                            purchasePriceRange: {
                                min: "$minPurchasePrice",
                                max: "$maxPurchasePrice",
                                formatted: {
                                    $cond: [
                                        { $gt: ["$maxPurchasePrice", 0] },
                                        {
                                            $cond: [
                                                { $eq: ["$minPurchasePrice", "$maxPurchasePrice"] },
                                                { $concat: ["৳", { $toString: "$minPurchasePrice" }] },
                                                { $concat: ["৳", { $toString: "$minPurchasePrice" }, " - ৳", { $toString: "$maxPurchasePrice" }] }
                                            ]
                                        },
                                        "N/A"
                                    ]
                                }
                            },
                            retailPriceRange: {
                                min: "$minRetailPrice",
                                max: "$maxRetailPrice",
                                formatted: {
                                    $cond: [
                                        { $gt: ["$maxRetailPrice", 0] },
                                        {
                                            $cond: [
                                                { $eq: ["$minRetailPrice", "$maxRetailPrice"] },
                                                { $concat: ["৳", { $toString: "$minRetailPrice" }] },
                                                { $concat: ["৳", { $toString: "$minRetailPrice" }, " - ৳", { $toString: "$maxRetailPrice" }] }
                                            ]
                                        },
                                        "N/A"
                                    ]
                                }
                            },
                            mrpRange: {
                                min: "$minMrp",
                                max: "$maxMrp",
                                formatted: {
                                    $cond: [
                                        { $gt: ["$maxMrp", 0] },
                                        {
                                            $cond: [
                                                { $eq: ["$minMrp", "$maxMrp"] },
                                                { $concat: ["৳", { $toString: "$minMrp" }] },
                                                { $concat: ["৳", { $toString: "$minMrp" }, " - ৳", { $toString: "$maxMrp" }] }
                                            ]
                                        },
                                        "N/A"
                                    ]
                                }
                            },
                            image: {
                                $let: {
                                    vars: {
                                        firstItem: {
                                            $cond: [
                                                { $isArray: "$images" },
                                                { $arrayElemAt: ["$images", 0] },
                                                { $ifNull: ["$images", "$image"] }
                                            ]
                                        }
                                    },
                                    in: {
                                        $cond: [
                                            { $eq: [{ $type: "$$firstItem" }, "object"] },
                                            { $ifNull: ["$$firstItem.url", ""] },
                                            {
                                                $cond: [
                                                    { $eq: [{ $type: "$$firstItem" }, "string"] },
                                                    "$$firstItem",
                                                    ""
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    },

                    // 10. Clean up internal temporary fields and omit requested heavy fields to make API lightweight
                    {
                        $project: {
                            // Internal temporary fields
                            purchases: 0,
                            categoryDoc: 0,
                            allPurchaseVariants: 0,
                            activeVariants: 0,
                            uniqueVariantTitles: 0,
                            inStockVariants: 0,
                            inStockPurchasePriced: 0,
                            allPurchasePriced: 0,
                            inStockRetailPriced: 0,
                            allRetailPriced: 0,
                            inStockMrpPriced: 0,
                            allMrpPriced: 0,
                            targetPurchasePriced: 0,
                            targetRetailPriced: 0,
                            targetMrpPriced: 0,

                            // Fields explicitly excluded to make API lightweight:
                            description: 0,
                            createdAt: 0,
                            updatedAt: 0,
                            hasImei: 0,
                            variantTypes: 0,
                            variants: 0,
                            minPurchasePrice: 0,
                            maxPurchasePrice: 0,
                            minRetailPrice: 0,
                            maxRetailPrice: 0,
                            minMrp: 0,
                            maxMrp: 0,
                            totalVariants: 0,
                            images: 0,
                            "category name": 0,
                            category_name: 0
                        }
                    }
                ];

                const result = await productCollection.aggregate(pipeline).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching aggregated products:", err);
                res.status(500).send({ message: "Failed to fetch products" });
            }
        });
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
        // ------------------------------------ PURCHASE APIs (purchases) -------------------------------------
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

        // POST /purchase -> Record a new stock purchase transaction with supplier details, invoice, and variants
        app.post("/purchase", async (req, res) => {
            try {
                const data = req.body;
                data.createdAt = new Date();
                data.updatedAt = new Date();
                const result = await purchaseCollection.insertOne(data);
                res.send(result);
            } catch (err) {
                console.error("Error creating purchase:", err);
                res.status(500).send({ message: "Failed to create purchase" });
            }
        });

        // ====================================================================================================
        // ------------------------------------ SUPPLIER APIs (suppliers) -------------------------------------
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
