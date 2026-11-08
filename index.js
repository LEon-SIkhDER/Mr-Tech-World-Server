const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
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
        const salesCollection = db.collection('sales');

        // Ensure unique index on invoiceNo to guarantee mathematical non-duplication
        salesCollection.createIndex({ invoiceNo: 1 }, { unique: true }).catch(err => console.error("Error creating sales invoice index:", err));

        // ====================================================================================================
        // * ------------------------------------------- Sales APIs  ------------------------------------------
        // ====================================================================================================

        // GET /sales -> Retrieve all completed sales records sorted by latest date
        app.get("/sales", async (req, res) => {
            try {
                const result = await salesCollection.find().sort({ createdAt: -1 }).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching sales:", err);
                res.status(500).send({ message: "Failed to fetch sales" });
            }
        });

        // POST /sale -> Record sale invoice with non-duplicate crypto invoice ID, deduct variant stock, FIFO batches & IMEIs
        app.post("/sale", async (req, res) => {
            try {
                const saleData = req.body;
                if (!saleData || !Array.isArray(saleData.items) || saleData.items.length === 0) {
                    return res.status(400).send({ message: "Sale must include at least one item." });
                }

                // 1. Generate unique invoice number with uppercase A-Z and digits 0-9 using crypto
                function generateInvoiceNo() {
                    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                    const bytes = crypto.randomBytes(6);
                    let randomCode = '';
                    for (let i = 0; i < bytes.length; i++) {
                        randomCode += chars[bytes[i] % chars.length];
                    }
                    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                    return `INV-${dateStr}-${randomCode}`;
                }

                saleData.invoiceNo = generateInvoiceNo();
                saleData.createdAt = new Date();
                saleData.updatedAt = new Date();

                // Helper to normalize and extract IMEI strings for comparison
                function extractImeiStrings(imeiArray) {
                    if (!Array.isArray(imeiArray)) return [];
                    const list = [];
                    for (const item of imeiArray) {
                        if (typeof item === 'object' && item !== null) {
                            if (item.imei1) list.push(String(item.imei1).trim().toLowerCase());
                            if (item.imei2) list.push(String(item.imei2).trim().toLowerCase());
                            if (item.imei) list.push(String(item.imei).trim().toLowerCase());
                        } else if (typeof item === 'string' && item.trim()) {
                            list.push(item.trim().toLowerCase());
                        }
                    }
                    return list;
                }

                // 2. Deduct inventory (variant quantity, FIFO batches, and IMEIs) via high-performance Batch & bulkWrite
                const uniqueProductIds = [
                    ...new Set(
                        saleData.items
                            .map((item) => item.productId)
                            .filter((id) => id && ObjectId.isValid(id))
                    )
                ].map((id) => new ObjectId(id));

                if (uniqueProductIds.length > 0) {
                    // Single network call to fetch all products in the cart (lightweight projection)
                    const fetchedProducts = await productCollection
                        .find(
                            { _id: { $in: uniqueProductIds } },
                            { projection: { variants: 1, hasImei: 1 } }
                        )
                        .toArray();

                    const productMap = new Map(fetchedProducts.map((p) => [p._id.toString(), p]));

                    // Process item deductions in-memory
                    for (const soldItem of saleData.items) {
                        if (!soldItem.productId) continue;
                        const product = productMap.get(soldItem.productId.toString());
                        if (!product || !Array.isArray(product.variants) || product.variants.length === 0) continue;

                        const soldQty = Number(soldItem.quantity) || 1;
                        const soldImeiSet = new Set(extractImeiStrings(soldItem.imeis));

                        product.variants = product.variants.map((variant) => {
                            const soldBarcode = String(soldItem.barcode || '').trim().toLowerCase();
                            const soldTitle = String(soldItem.variantTitle || '').trim().toLowerCase();
                            const variantBarcode = String(variant.barcode || '').trim().toLowerCase();
                            const variantTitle = String(variant.title || '').trim().toLowerCase();

                            const isMatch = (soldBarcode && variantBarcode && variantBarcode === soldBarcode) ||
                                            (soldTitle && variantTitle && variantTitle === soldTitle) ||
                                            (product.variants.length === 1);

                            if (!isMatch) return variant;

                            // A. Deduct total quantity
                            const newQuantity = Math.max(0, (Number(variant.quantity) || 0) - soldQty);

                            // B. Deduct from FIFO batches
                            let qtyToDeduct = soldQty;
                            const updatedBatches = (variant.batches || []).map((batch) => {
                                if (qtyToDeduct <= 0) return batch;
                                const available = Number(batch.remainingQuantity) || 0;
                                if (available <= 0) return batch;

                                const deducted = Math.min(available, qtyToDeduct);
                                qtyToDeduct -= deducted;
                                const newRemaining = available - deducted;

                                // If batch tracks IMEIs, filter out the sold IMEIs
                                let batchImeis = batch.imeis;
                                if (Array.isArray(batchImeis) && soldImeiSet.size > 0) {
                                    batchImeis = batchImeis.filter((bi) => {
                                        const im1 = typeof bi === 'object' ? (bi.imei1 || '') : String(bi || '');
                                        const im2 = typeof bi === 'object' ? (bi.imei2 || '') : '';
                                        return (!im1 || !soldImeiSet.has(im1.trim().toLowerCase())) &&
                                               (!im2 || !soldImeiSet.has(im2.trim().toLowerCase()));
                                    });
                                }

                                return {
                                    ...batch,
                                    remainingQuantity: newRemaining,
                                    ...(batchImeis !== undefined ? { imeis: batchImeis } : {})
                                };
                            });

                            // C. Remove sold IMEIs from variant.imeis
                            let remainingImeis = variant.imeis;
                            if (Array.isArray(remainingImeis) && soldImeiSet.size > 0) {
                                remainingImeis = remainingImeis.filter((bi) => {
                                    const im1 = typeof bi === 'object' ? (bi.imei1 || '') : String(bi || '');
                                    const im2 = typeof bi === 'object' ? (bi.imei2 || '') : '';
                                    return (!im1 || !soldImeiSet.has(im1.trim().toLowerCase())) &&
                                           (!im2 || !soldImeiSet.has(im2.trim().toLowerCase()));
                                });
                            }

                            return {
                                ...variant,
                                quantity: newQuantity,
                                batches: updatedBatches,
                                imeis: remainingImeis,
                                updatedAt: new Date()
                            };
                        });
                    }

                    // Package into 1 single bulkWrite network request
                    const bulkOperations = [];
                    for (const product of productMap.values()) {
                        const totalStock = product.variants.reduce((sum, v) => sum + (Number(v.quantity) || 0), 0);
                        bulkOperations.push({
                            updateOne: {
                                filter: { _id: product._id },
                                update: {
                                    $set: {
                                        variants: product.variants,
                                        quantity: totalStock,
                                        updatedAt: new Date()
                                    }
                                }
                            }
                        });
                    }

                    if (bulkOperations.length > 0) {
                        await productCollection.bulkWrite(bulkOperations, { ordered: false });
                    }
                }

                // 3. Save sale invoice record in salesCollection (with duplicate retry safety)
                let result;
                try {
                    result = await salesCollection.insertOne(saleData);
                } catch (insertErr) {
                    if (insertErr.code === 11000) {
                        delete saleData._id;
                        saleData.invoiceNo = generateInvoiceNo();
                        result = await salesCollection.insertOne(saleData);
                    } else {
                        throw insertErr;
                    }
                }

                // 4. Return invoice details for frontend toast & print receipt modal
                res.send({
                    success: true,
                    insertedId: result.insertedId,
                    invoiceNo: saleData.invoiceNo,
                    // sale: saleData
                });
            } catch (err) {
                console.error("Error processing sale:", err);
                res.status(500).send({ message: "Failed to process sale" });
            }
        });






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

        // GET /products -> List of products with live variant stock, price ranges, and category name
        app.get("/products", async (req, res) => {
            try {
                const pipeline = [
                    {
                        $lookup: {
                            from: "categories",
                            let: { catId: "$category" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $eq: ["$_id", "$$catId"] },
                                                { $eq: [{ $toString: "$_id" }, { $toString: "$$catId" }] },
                                                { $eq: ["$name", "$$catId"] }
                                            ]
                                        }
                                    }
                                }
                            ],
                            as: "categoryDoc"
                        }
                    },
                    {
                        $addFields: {
                            categoryName: {
                                $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, "Uncategorized"]
                            },
                            variants: { $ifNull: ["$variants", []] },
                            totalStock: {
                                $reduce: {
                                    input: { $ifNull: ["$variants", []] },
                                    initialValue: 0,
                                    in: { $add: ["$$value", { $toDouble: { $ifNull: ["$$this.quantity", 0] } }] }
                                }
                            },
                            variantsCount: { $size: { $ifNull: ["$variants", []] } },
                            minRetailPrice: { $min: "$variants.retailPrice" },
                            maxRetailPrice: { $max: "$variants.retailPrice" },
                            minMrp: { $min: "$variants.mrp" },
                            maxMrp: { $max: "$variants.mrp" },
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
                    {
                        $addFields: {
                            retailPriceRange: {
                                min: { $ifNull: ["$minRetailPrice", 0] },
                                max: { $ifNull: ["$maxRetailPrice", 0] },
                                formatted: {
                                    $cond: [
                                        { $gt: [{ $ifNull: ["$maxRetailPrice", 0] }, 0] },
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
                                min: { $ifNull: ["$minMrp", 0] },
                                max: { $ifNull: ["$maxMrp", 0] },
                                formatted: {
                                    $cond: [
                                        { $gt: [{ $ifNull: ["$maxMrp", 0] }, 0] },
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
                            }
                        }
                    },
                    {
                        $project: {
                            categoryDoc: 0
                        }
                    }
                ];

                const result = await productCollection.aggregate(pipeline).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching products:", err);
                res.status(500).send({ message: "Failed to fetch products" });
            }
        });

        // GET /product/variants/:id -> Retrieve variant attributes, product type, and existing variants
        app.get("/product/variants/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID format" });
                }
                const query = { _id: new ObjectId(id) };
                const projection = {
                    projection: {
                        name: 1,
                        productType: 1,
                        hasImei: 1,
                        variantAttributes: 1,
                        variantTypes: 1,
                        variants: 1
                    }
                };
                const result = await productCollection.findOne(query, projection);
                if (!result) {
                    return res.status(404).send({ message: "Product not found" });
                }
                res.send(result);
            } catch (err) {
                console.error("Error fetching product variants:", err);
                res.status(500).send({ message: "Failed to fetch variants" });
            }
        });

        app.get("/products/pos", async (req, res) => {
            try {
                const { search, category, limit, skip } = req.query;
                let query = {};
                if (search) {
                    query.name = { $regex: search, $options: 'i' };
                }
                if (category) {
                    query.category = category;
                }

                const skipNum = Number(skip) || 0;
                const limitNum = Number(limit) || 12;

                const [totalProductCounts, products] = await Promise.all([
                    productCollection.countDocuments(query),
                    productCollection.aggregate([
                        { $match: query },
                        { $skip: skipNum },
                        { $limit: limitNum },
                        {
                            $set: {
                                image: {
                                    $getField: {
                                        field: "url",
                                        input: { $arrayElemAt: ["$images", 0] }
                                    }
                                }
                            }
                        },
                        {
                            $project: {
                                images: 0
                            }
                        }
                    ]).toArray()
                ]);

                res.send({
                    products,
                    totalProductCounts
                });
            } catch (err) {
                console.error("Error fetching POS products:", err);
                res.status(500).send({ message: "Failed to fetch products" });
            }
        });

        // GET /products-name-id -> Retrieve product names and IDs only for search comboboxes and selection inputs
        app.get("/products-name-id", async (req, res) => {
            try {
                const projection = { projection: { name: 1, productType: 1 } };
                const result = await productCollection.find({}, projection).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching products name and ID:", err);
                res.status(500).send({ message: "Failed to fetch products" });
            }
        });

        // GET /product/scan/barcode/:barcode -> Scan barcode (or IMEI) and return projected product data shaped for POS cart
        app.get("/product/scan/barcode/:barcode", async (req, res) => {
            try {
                const { barcode } = req.params;
                const cleanBarcode = String(barcode || '').trim();
                const cleanId = cleanBarcode;
                if (!cleanBarcode) {
                    return res.status(400).send({ message: "Barcode is required" });
                }

                const idRegex = new RegExp(`^${cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

                const query = {
                    $or: [
                        { "variants.barcode": idRegex },
                        { barcode: idRegex },
                        { "variants.imeis.imei1": idRegex },
                        { "variants.imeis.imei2": idRegex },
                        { "variants.imeis": idRegex }
                    ]
                };

                const projection = {
                    projection: {
                        name: 1,
                        brand: 1,
                        model: 1,
                        images: 1,
                        image: 1,
                        hasImei: 1,
                        warranty: 1,
                        productType: 1,
                        barcode: 1,
                        retailPrice: 1,
                        mrp: 1,
                        quantity: 1,
                        variants: {
                            $elemMatch: {
                                $or: [
                                    { barcode: idRegex },
                                    { "imeis.imei1": idRegex },
                                    { "imeis.imei2": idRegex },
                                    { imeis: idRegex }
                                ]
                            }
                        }
                    }
                };

                const product = await productCollection.findOne(query, projection);
                if (!product) {
                    return res.status(404).send({ message: "Product not found" });
                }

                const variant = Array.isArray(product.variants) && product.variants.length > 0
                    ? product.variants[0]
                    : {
                        title: 'Standard',
                        barcode: product.barcode || cleanId,
                        retailPrice: Number(product.retailPrice) || 0,
                        mrp: Number(product.mrp) || 0,
                        quantity: Number(product.quantity) || 0,
                        imeis: Array.isArray(product.imeis) ? product.imeis : []
                    };

                const currentPriceType = req.query.priceType === 'retailPrice' ? 'retailPrice' : 'mrp';
                const retailPrice = Number(variant.retailPrice) || Number(product.retailPrice) || 0;
                const mrp = Number(variant.mrp) || Number(product.mrp) || retailPrice;
                const unitPrice = currentPriceType === 'retailPrice' ? retailPrice : mrp;
                const availableStock = Number(variant.quantity) || 0;

                let image = '';
                if (typeof product.image === 'string' && product.image) {
                    image = product.image;
                } else if (Array.isArray(product.images) && product.images.length > 0) {
                    const firstImg = product.images[0];
                    image = typeof firstImg === 'object' && firstImg !== null ? (firstImg.url || '') : String(firstImg || '');
                }

                const itemKey = `${product._id}-${variant.barcode || variant.title || 'default'}`;

                // Check if scanned code matches any IMEI of the variant
                let selectedImeis = [];
                const matchedImeiObj = Array.isArray(variant.imeis) && variant.imeis.find(item => {
                    if (typeof item === 'object' && item !== null) {
                        return (item.imei1 && item.imei1.toLowerCase() === cleanId.toLowerCase()) ||
                            (item.imei2 && item.imei2.toLowerCase() === cleanId.toLowerCase());
                    }
                    return String(item || '').toLowerCase() === cleanId.toLowerCase();
                });
                if (matchedImeiObj) {
                    const matchedVal = typeof matchedImeiObj === 'object'
                        ? (matchedImeiObj.imei1?.toLowerCase() === cleanId.toLowerCase() ? matchedImeiObj.imei1 : matchedImeiObj.imei2)
                        : matchedImeiObj;
                    selectedImeis = [matchedVal];
                }

                const cartData = {
                    itemKey,
                    productId: product._id,
                    name: product.name || 'Unnamed Product',
                    brand: product.brand || '',
                    model: product.model || '',
                    image,
                    variantTitle: variant.title || '',
                    barcode: variant.barcode || cleanId,
                    retailPrice,
                    mrp,
                    priceType: currentPriceType,
                    unitPrice,
                    quantity: 1,
                    total: unitPrice,
                    maxStock: availableStock,
                    hasImei: Boolean(product.hasImei),
                    availableImeis: Array.isArray(variant.imeis) ? variant.imeis : [],
                    selectedImeis,
                    warranty: product.warranty || 0
                };

                res.send(cartData);
            } catch (err) {
                console.error("Error scanning product barcode:", err);
                res.status(500).send({ message: "Failed to scan product barcode" });
            }
        });

        // GET /products/scan/barcode/:barcode -> Route alias for plural URL compatibility
        // app.get("/products/scan/barcode/:barcode", (req, res) => {
        //     const queryParams = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        //     res.redirect(307, `/product/scan/barcode/${encodeURIComponent(req.params.barcode)}${queryParams}`);
        // });

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

                // Normalize IMEIs across purchased variants
                if (Array.isArray(data.variants)) {
                    data.variants = data.variants.map(v => ({
                        ...v,
                        imeis: (Array.isArray(v.imeis) ? v.imeis : []).map(item => {
                            if (typeof item === 'string') {
                                const trimmed = item.trim();
                                return trimmed ? { imei1: trimmed, imei2: "" } : null;
                            }
                            if (item && typeof item === 'object') {
                                const im1 = (item.imei1 || item.imei || "").trim();
                                const im2 = (item.imei2 || "").trim();
                                return im1 ? { imei1: im1, imei2: im2 } : null;
                            }
                            return null;
                        }).filter(Boolean)
                    }));
                }

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

                        const isSimple = product.productType === "simple" || data.productType === "simple";

                        for (const incoming of purchasedVariants) {
                            const incomingTitle = (incoming.title || "").trim().toLowerCase();
                            const incomingBarcode = (incoming.barcode || "").trim().toLowerCase();
                            const incomingQty = Number(incoming.quantity) || 0;
                            const incomingPrice = Number(incoming.purchasePrice) || 0;
                            const incomingImeis = Array.isArray(incoming.imeis) ? incoming.imeis : [];

                            // Create new batch record for this purchase with its specific IMEIs
                            const newBatch = {
                                batchId: new ObjectId().toString(),
                                invoiceNo: data.invoiceNo || "",
                                supplierId: data.supplierId || null,
                                purchasePrice: incomingPrice,
                                receivedQuantity: incomingQty,
                                remainingQuantity: incomingQty,
                                imeis: incomingImeis,
                                purchaseDate: data.purchaseDate ? new Date(data.purchaseDate) : new Date(),
                                createdAt: new Date()
                            };

                            // Match existing variant by title or barcode (or single standard variant if simple product)
                            const matchIndex = updatedVariants.findIndex((v) => {
                                if (isSimple && updatedVariants.length === 1) {
                                    return true;
                                }
                                const vTitle = (v.title || "").trim().toLowerCase();
                                const vBarcode = (v.barcode || "").trim().toLowerCase();
                                const titleMatch = incomingTitle && vTitle && vTitle === incomingTitle;
                                const barcodeMatch = incomingBarcode && vBarcode && vBarcode === incomingBarcode;
                                return titleMatch || barcodeMatch;
                            });

                            if (matchIndex !== -1) {
                                const existing = updatedVariants[matchIndex];
                                const existingBatches = Array.isArray(existing.batches) ? [...existing.batches] : [];

                                // Backfill legacy stock if variant had existing quantity but no batches
                                if (existingBatches.length === 0 && (Number(existing.quantity) || 0) > 0) {
                                    const legacyImeis = (Array.isArray(existing.imeis) ? existing.imeis : []).map(item => {
                                        if (typeof item === 'string') {
                                            const trimmed = item.trim();
                                            return trimmed ? { imei1: trimmed, imei2: "" } : null;
                                        }
                                        if (item && typeof item === 'object') {
                                            const im1 = (item.imei1 || item.imei || "").trim();
                                            const im2 = (item.imei2 || "").trim();
                                            return im1 ? { imei1: im1, imei2: im2 } : null;
                                        }
                                        return null;
                                    }).filter(Boolean);

                                    existingBatches.push({
                                        batchId: new ObjectId().toString(),
                                        invoiceNo: "INITIAL-STOCK",
                                        supplierId: null,
                                        purchasePrice: Number(existing.purchasePrice) || 0,
                                        receivedQuantity: Number(existing.quantity) || 0,
                                        remainingQuantity: Number(existing.quantity) || 0,
                                        imeis: legacyImeis,
                                        purchaseDate: existing.createdAt ? new Date(existing.createdAt) : new Date(),
                                        createdAt: new Date()
                                    });
                                }
                                if (incomingQty > 0) {
                                    existingBatches.push(newBatch);
                                }

                                // Gather all active IMEIs across all batches for fast variant lookup
                                const seen = new Set();
                                const allActiveImeis = [];
                                for (const b of existingBatches) {
                                    if (Array.isArray(b.imeis)) {
                                        for (const item of b.imeis) {
                                            let im1 = "";
                                            let im2 = "";
                                            if (typeof item === 'string') {
                                                im1 = item.trim();
                                            } else if (item && typeof item === 'object') {
                                                im1 = (item.imei1 || item.imei || "").trim();
                                                im2 = (item.imei2 || "").trim();
                                            }
                                            if (im1 && !seen.has(im1.toLowerCase())) {
                                                seen.add(im1.toLowerCase());
                                                allActiveImeis.push({ imei1: im1, imei2: im2 });
                                            }
                                        }
                                    }
                                }

                                // Strip any legacy purchasePrice / lastPurchasePrice off the variant root
                                const { purchasePrice, lastPurchasePrice, ...cleanedExisting } = existing;

                                updatedVariants[matchIndex] = {
                                    ...cleanedExisting,
                                    title: existing.title || incoming.title || (isSimple ? "Standard" : ""),
                                    combination: existing.combination || incoming.combination || [],
                                    quantity: (Number(existing.quantity) || 0) + incomingQty,
                                    retailPrice: Number(incoming.retailPrice) || existing.retailPrice || 0,
                                    mrp: Number(incoming.mrp) || existing.mrp || 0,
                                    barcode: incoming.barcode || existing.barcode || "",
                                    batches: existingBatches,
                                    imeis: allActiveImeis,
                                    updatedAt: new Date()
                                };
                            } else {
                                // Brand new variant -> push it into the product variants array
                                updatedVariants.push({
                                    title: incoming.title || (isSimple ? "Standard" : ""),
                                    combination: Array.isArray(incoming.combination) ? incoming.combination : [],
                                    attributes: Array.isArray(incoming.attributes) ? incoming.attributes : [],
                                    barcode: incoming.barcode || "",
                                    retailPrice: Number(incoming.retailPrice) || 0,
                                    mrp: Number(incoming.mrp) || 0,
                                    quantity: incomingQty,
                                    batches: incomingQty > 0 ? [newBatch] : [],
                                    imeis: incomingImeis,
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
