const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
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

        salesCollection.createIndex({ createdAt: -1 }).catch(() => { });
        salesCollection.createIndex({ paymentStatus: 1 }).catch(() => { });
        salesCollection.createIndex({ paymentMethod: 1 }).catch(() => { });
        salesCollection.createIndex({ totalPayable: 1 }).catch(() => { });

        // Category & Product indexes for fast relational lookup and sort
        productCollection.createIndex({ status: 1 }).catch(() => { });
        productCollection.createIndex({ status: 1, category: 1 }).catch(() => { });
        productCollection.createIndex({ category: 1 }).catch(() => { });
        productCollection.createIndex({ createdAt: -1 }).catch(() => { });
        productCollection.createIndex({ name: 1 }).catch(() => { });
        productCollection.createIndex({ brand: 1 }).catch(() => { });
        productCollection.createIndex({ "variants.barcode": 1 }).catch(() => { });
        categoryCollection.createIndex({ createdAt: -1 }).catch(() => { });

        // Supplier & Purchase indexes for fast relational lookup, purchase linking, and sort
        supplierCollection.createIndex({ createdAt: -1 }).catch(() => { });
        purchaseCollection.createIndex({ supplierId: 1 }).catch(() => { });
        productCollection.createIndex({ "variants.batches.supplierId": 1 }).catch(() => { });

        // GET /sales/report -> High performance aggregation API for sales report, filters, stats, & pagination
        app.get("/sales/report", async (req, res) => {
            try {
                const {
                    search,
                    startDate,
                    endDate,
                    paymentStatus,
                    paymentMethod,
                    orderStatus,
                    returnStatus,
                    minAmount,
                    maxAmount,
                    category,
                    page,
                    limit,
                    sortBy,
                    sortOrder
                } = req.query;

                const andConditions = [];
                let hasActiveFilters = false;

                // 1. Date range filter on createdAt / saleDate
                if (startDate || endDate) {
                    hasActiveFilters = true;
                    const dateQuery = {};
                    const isoQuery = {};
                    if (startDate) {
                        const s = new Date(startDate);
                        s.setHours(0, 0, 0, 0);
                        dateQuery.$gte = s;
                        isoQuery.$gte = s.toISOString();
                    }
                    if (endDate) {
                        const e = new Date(endDate);
                        e.setHours(23, 59, 59, 999);
                        dateQuery.$lte = e;
                        isoQuery.$lte = e.toISOString();
                    }
                    andConditions.push({
                        $or: [
                            { createdAt: dateQuery },
                            { saleDate: isoQuery }
                        ]
                    });
                }

                // 2. Search query filter
                if (search && search.trim()) {
                    hasActiveFilters = true;
                    const clean = search.trim();
                    const regex = new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    andConditions.push({
                        $or: [
                            { invoiceNo: regex },
                            { "customer.name": regex },
                            { "customer.phone": regex },
                            { "items.name": regex },
                            { "items.brand": regex },
                            { "items.model": regex },
                            { "items.barcode": regex },
                            { "items.imeis.imei1": regex },
                            { "items.imeis.imei2": regex }
                        ]
                    });
                }

                // 3. Payment Status filter
                if (paymentStatus && paymentStatus !== 'all') {
                    hasActiveFilters = true;
                    andConditions.push({ paymentStatus: paymentStatus.toLowerCase() });
                }

                // 4. Payment Method filter
                if (paymentMethod && paymentMethod !== 'all') {
                    hasActiveFilters = true;
                    andConditions.push({ paymentMethod: new RegExp(`^${paymentMethod}$`, 'i') });
                }

                // 5. Order Status filter
                if (orderStatus && orderStatus !== 'all') {
                    hasActiveFilters = true;
                    andConditions.push({ orderStatus: orderStatus.toLowerCase() });
                }

                // 6. Return Status filter
                if (returnStatus && returnStatus !== 'all') {
                    hasActiveFilters = true;
                    andConditions.push({ returnStatus: returnStatus.toLowerCase() });
                }

                // 7. Amount Range (totalPayable)
                if (minAmount !== undefined && minAmount !== '' && !isNaN(Number(minAmount))) {
                    hasActiveFilters = true;
                    andConditions.push({ totalPayable: { $gte: Number(minAmount) } });
                }
                if (maxAmount !== undefined && maxAmount !== '' && !isNaN(Number(maxAmount))) {
                    hasActiveFilters = true;
                    andConditions.push({ totalPayable: { $lte: Number(maxAmount) } });
                }

                // 8. Category filter
                if (category && category !== 'all') {
                    hasActiveFilters = true;
                    andConditions.push({ "items.category": category });
                }

                const matchQuery = andConditions.length > 0 ? { $and: andConditions } : {};

                // Pagination & Sorting setup
                const pageNum = Math.max(1, parseInt(page, 10) || 1);
                const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 10));
                const skipNum = (pageNum - 1) * limitNum;

                const allowedSortFields = ['createdAt', 'totalPayable', 'paidAmount', 'dueAmount', 'totalCartItems'];
                const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
                const sortDirection = sortOrder === 'asc' ? 1 : -1;

                // High-performance aggregation pipeline with $facet
                const pipeline = [
                    { $match: matchQuery },
                    {
                        $facet: {
                            summary: [
                                {
                                    $group: {
                                        _id: null,
                                        totalRevenue: { $sum: { $ifNull: ["$totalPayable", 0] } },
                                        totalCollection: { $sum: { $ifNull: ["$paidAmount", 0] } },
                                        totalDue: { $sum: { $ifNull: ["$dueAmount", 0] } },
                                        totalSubtotal: { $sum: { $ifNull: ["$subtotal", 0] } },
                                        totalDiscount: { $sum: { $ifNull: ["$discountAmount", 0] } },
                                        totalDeliveryFee: { $sum: { $ifNull: ["$deliveryFee", 0] } },
                                        totalItemsSold: { $sum: { $ifNull: ["$totalCartItems", 0] } },
                                        totalOrders: { $sum: 1 }
                                    }
                                }
                            ],
                            sales: [
                                { $sort: { [sortField]: sortDirection } },
                                { $skip: skipNum },
                                { $limit: limitNum }
                            ]
                        }
                    }
                ];

                // Overall lifetime summary (unfiltered stats) for baseline/comparison
                const overallPipeline = [
                    {
                        $group: {
                            _id: null,
                            totalRevenue: { $sum: { $ifNull: ["$totalPayable", 0] } },
                            totalCollection: { $sum: { $ifNull: ["$paidAmount", 0] } },
                            totalDue: { $sum: { $ifNull: ["$dueAmount", 0] } },
                            totalSubtotal: { $sum: { $ifNull: ["$subtotal", 0] } },
                            totalDiscount: { $sum: { $ifNull: ["$discountAmount", 0] } },
                            totalDeliveryFee: { $sum: { $ifNull: ["$deliveryFee", 0] } },
                            totalItemsSold: { $sum: { $ifNull: ["$totalCartItems", 0] } },
                            totalOrders: { $sum: 1 }
                        }
                    }
                ];

                const [facetResult, overallResult] = await Promise.all([
                    salesCollection.aggregate(pipeline).toArray(),
                    salesCollection.aggregate(overallPipeline).toArray()
                ]);

                const facetData = facetResult[0] || { summary: [], sales: [] };
                const defaultSummary = {
                    totalRevenue: 0,
                    totalCollection: 0,
                    totalDue: 0,
                    totalSubtotal: 0,
                    totalDiscount: 0,
                    totalDeliveryFee: 0,
                    totalItemsSold: 0,
                    totalOrders: 0
                };

                const filteredStats = facetData.summary[0] || defaultSummary;
                const overallStats = overallResult[0] || defaultSummary;

                const totalOrdersCount = filteredStats.totalOrders;
                const totalPages = Math.ceil(totalOrdersCount / limitNum) || 1;

                res.send({
                    success: true,
                    sales: facetData.sales,
                    filteredStats,
                    overallStats,
                    pagination: {
                        totalCount: totalOrdersCount,
                        totalPages,
                        currentPage: pageNum,
                        limit: limitNum,
                        hasNextPage: pageNum < totalPages,
                        hasPrevPage: pageNum > 1
                    },
                    isFiltered: hasActiveFilters
                });
            } catch (err) {
                console.error("Error generating sales report:", err);
                res.status(500).send({ message: "Failed to generate sales report" });
            }
        });

        // GET /sales/:id -> Retrieve complete single sale details by ObjectId or invoiceNo
        app.get("/sales/:id", async (req, res) => {
            try {
                const { id } = req.params;
                let query;
                if (ObjectId.isValid(id)) {
                    query = { $or: [{ _id: new ObjectId(id) }, { invoiceNo: id }] };
                } else {
                    query = { invoiceNo: id };
                }
                const sale = await salesCollection.findOne(query);
                if (!sale) {
                    return res.status(404).send({ message: "Sale record not found" });
                }
                res.send(sale);
            } catch (err) {
                console.error("Error fetching sale details:", err);
                res.status(500).send({ message: "Failed to fetch sale details" });
            }
        });


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

                // 1. Generate unique invoice number: "IN-" prefix + 5 crypto characters (e.g. IN-EUCUC)
                function generateInvoiceNo() {
                    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                    let randomCode = '';
                    for (let i = 0; i < 5; i++) {
                        randomCode += chars[crypto.randomInt(0, chars.length)];
                    }
                    return `IN-${randomCode}`;
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
                            { projection: { variants: 1, hasImei: 1, status: 1, name: 1 } }
                        )
                        .toArray();

                    const productMap = new Map(fetchedProducts.map((p) => [p._id.toString(), p]));

                    // Validate that no product in the sale is inactive
                    for (const item of saleData.items) {
                        if (!item.productId) continue;
                        const prod = productMap.get(item.productId.toString());
                        if (prod && prod.status && prod.status !== "active") {
                            return res.status(400).send({
                                message: `Cannot complete sale: "${prod.name || 'Product'}" is inactive.`
                            });
                        }
                    }

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

        // GET /categories -> High-performance aggregation pipeline returning categories with product counts, stock metrics, & live search
        app.get("/categories", async (req, res) => {
            try {
                const { search, q } = req.query;
                const searchQuery = (search || q || "").trim();

                const pipeline = [];

                // 1. Initial filter stage for search query (runs first to optimize performance before lookup)
                if (searchQuery) {
                    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    pipeline.push({
                        $match: {
                            $or: [
                                { name: regex },
                                { description: regex }
                            ]
                        }
                    });
                }

                // 2. High-performance lookup & inventory metrics calculation
                pipeline.push(
                    {
                        $lookup: {
                            from: "products",
                            let: { catIdStr: { $toString: "$_id" }, catId: "$_id", catName: "$name" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $and: [{ $ne: ["$$catIdStr", null] }, { $eq: ["$category", "$$catIdStr"] }] },
                                                { $and: [{ $ne: ["$$catId", null] }, { $eq: ["$category", "$$catId"] }] },
                                                { $and: [{ $ne: ["$$catName", null] }, { $ne: ["$$catName", ""] }, { $eq: ["$category", "$$catName"] }] }
                                            ]
                                        }
                                    }
                                },
                                {
                                    $project: {
                                        _id: 1,
                                        stock: {
                                            $cond: [
                                                { $gt: [{ $size: { $ifNull: ["$variants", []] } }, 0] },
                                                {
                                                    $reduce: {
                                                        input: { $ifNull: ["$variants", []] },
                                                        initialValue: 0,
                                                        in: { $add: ["$$value", { $toDouble: { $ifNull: ["$$this.quantity", 0] } }] }
                                                    }
                                                },
                                                { $toDouble: { $ifNull: ["$quantity", 0] } }
                                            ]
                                        }
                                    }
                                },
                                {
                                    $group: {
                                        _id: null,
                                        productsCount: { $sum: 1 },
                                        totalStock: { $sum: "$stock" }
                                    }
                                }
                            ],
                            as: "stats"
                        }
                    },
                    {
                        $addFields: {
                            statsDoc: { $arrayElemAt: ["$stats", 0] }
                        }
                    },
                    {
                        $addFields: {
                            productsCount: { $ifNull: ["$statsDoc.productsCount", 0] },
                            totalProducts: { $ifNull: ["$statsDoc.productsCount", 0] },
                            totalStock: { $ifNull: ["$statsDoc.totalStock", 0] }
                        }
                    },
                    {
                        $project: {
                            stats: 0,
                            statsDoc: 0
                        }
                    },
                    {
                        $sort: { createdAt: -1, _id: -1 }
                    }
                );

                const result = await categoryCollection.aggregate(pipeline).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching categories:", err);
                res.status(500).send({ message: "Failed to fetch categories" });
            }
        });

        // GET /categories/names -> Retrieve category names and IDs only with optional search (lightweight for dropdown select menus)
        app.get("/categories/names", async (req, res) => {
            try {
                const { search, q } = req.query;
                const searchQuery = (search || q || "").trim();
                const query = {};
                if (searchQuery) {
                    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    query.$or = [{ name: regex }, { description: regex }];
                }
                const projection = { projection: { name: 1 } };
                const result = await categoryCollection.find(query, projection).toArray();
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

        // PUT /category/:id -> Update an existing category by ObjectId
        app.put("/category/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid category ID format" });
                }

                const { name, description } = req.body;
                if (!name || !name.trim()) {
                    return res.status(400).send({ message: "Category name is required" });
                }

                const existingCategory = await categoryCollection.findOne({ _id: new ObjectId(id) });
                if (!existingCategory) {
                    return res.status(404).send({ message: "Category not found" });
                }

                const trimmedName = name.trim();
                const trimmedDesc = (description || "").trim();

                const updateDoc = {
                    $set: {
                        name: trimmedName,
                        description: trimmedDesc,
                        updatedAt: new Date()
                    }
                };

                const result = await categoryCollection.updateOne({ _id: new ObjectId(id) }, updateDoc);

                // If category name changed, update product references that store category by name
                if (existingCategory.name && existingCategory.name !== trimmedName) {
                    await productCollection.updateMany(
                        { category: existingCategory.name },
                        { $set: { category: trimmedName } }
                    ).catch(err => console.error("Error syncing product category name references:", err));
                }

                res.send(result);
            } catch (err) {
                console.error("Error updating category:", err);
                res.status(500).send({ message: "Failed to update category" });
            }
        });

        // DELETE /category/:id -> Delete a category only if no products are assigned to it
        // DELETE /category/:id -> Single round-trip pre-check
        app.delete("/category/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid category ID format" });
                }

                // 1. Single round-trip: Verifies existence AND counts linked products
                const [check] = await categoryCollection.aggregate([
                    { $match: { _id: new ObjectId(id) } },
                    {
                        $lookup: {
                            from: "products",
                            let: { catId: "$_id", catStr: { $toString: "$_id" }, catName: "$name" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $eq: ["$category", "$$catId"] },
                                                { $eq: ["$category", "$$catStr"] },
                                                { $eq: ["$category", "$$catName"] }
                                            ]
                                        }
                                    }
                                },
                                { $count: "count" }
                            ],
                            as: "productCheck"
                        }
                    }
                ]).toArray();

                // Category not found
                if (!check) {
                    return res.status(404).send({ message: "Category not found" });
                }

                const assignedCount = check.productCheck[0]?.count || 0;
                if (assignedCount > 0) {
                    return res.status(400).send({
                        message: `Cannot delete category: ${assignedCount} product(s) are assigned to this category. Please reassign or delete them first.`
                    });
                }

                // 2. Safe to delete (only 1 additional call)
                const result = await categoryCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (err) {
                console.error("Error deleting category:", err);
                res.status(500).send({ message: "Failed to delete category" });
            }
        });

        // ====================================================================================================
        // * ------------------------------------ PRODUCT APIs (products) ---------------------------------------
        // ====================================================================================================

        // GET /products -> High performance, paginated product catalog with search, filter, and sorting
        app.get("/products", async (req, res) => {
            try {
                const {
                    search,
                    category,
                    stockStatus = "all",
                    status = "all",
                    page,
                    limit,
                    sortBy = "createdAt",
                    sortOrder = "desc",
                    paginate
                } = req.query;

                const pageNum = Math.max(1, parseInt(page, 10) || 1);
                const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
                const skipNum = (pageNum - 1) * limitNum;

                // 1. Match Stage (Search & Category)
                const andConditions = [];

                if (search && search.trim()) {
                    const cleanSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const searchRegex = new RegExp(cleanSearch, 'i');
                    andConditions.push({
                        $or: [
                            { name: searchRegex },
                            { brand: searchRegex },
                            { model: searchRegex },
                            { "variants.barcode": searchRegex }
                        ]
                    });
                }

                if (category && category !== 'all' && category.trim()) {
                    const trimmedCat = category.trim();
                    if (ObjectId.isValid(trimmedCat)) {
                        andConditions.push({
                            $or: [
                                { category: trimmedCat },
                                { category: new ObjectId(trimmedCat) }
                            ]
                        });
                    } else {
                        andConditions.push({ category: trimmedCat });
                    }
                }

                if (status && status !== 'all' && status.trim()) {
                    andConditions.push({ status: status.trim() });
                }

                const matchStage = andConditions.length > 0 ? { $and: andConditions } : {};

                // 2. Sorting Stage
                const sortDirection = sortOrder === "asc" ? 1 : -1;
                let sortStage = { createdAt: -1 };
                if (sortBy === "name") {
                    sortStage = { name: sortDirection };
                } else if (sortBy === "stock" || sortBy === "totalStock") {
                    sortStage = { totalStock: sortDirection };
                } else {
                    sortStage = { [sortBy]: sortDirection };
                }

                // 3. Optimized Aggregation Pipeline
                const pipeline = [
                    { $match: matchStage },
                    {
                        $addFields: {
                            variants: { $ifNull: ["$variants", []] },
                            totalStock: {
                                $reduce: {
                                    input: { $ifNull: ["$variants", []] },
                                    initialValue: 0,
                                    in: { $add: ["$$value", { $toDouble: { $ifNull: ["$$this.quantity", 0] } }] }
                                }
                            }
                        }
                    }
                ];

                // Filter by stock status if provided
                if (stockStatus && stockStatus !== 'all') {
                    if (stockStatus === 'inStock') {
                        pipeline.push({ $match: { totalStock: { $gt: 0 } } });
                    } else if (stockStatus === 'lowStock') {
                        pipeline.push({ $match: { totalStock: { $gt: 0, $lte: 10 } } });
                    } else if (stockStatus === 'outOfStock') {
                        pipeline.push({ $match: { totalStock: { $lte: 0 } } });
                    }
                }

                pipeline.push({ $sort: sortStage });

                // Check if consumer specifically requested an unpaginated flat array
                const isExplicitlyUnpaginated = paginate === 'false' || req.query.all === 'true';

                // Project and compute rich product details
                const projectProductDetailsStages = [
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
                            variantsCount: { $size: "$variants" },
                            validRetailPrices: {
                                $filter: {
                                    input: "$variants.retailPrice",
                                    as: "p",
                                    cond: { $gt: ["$$p", 0] }
                                }
                            },
                            validMrps: {
                                $filter: {
                                    input: "$variants.mrp",
                                    as: "m",
                                    cond: { $gt: ["$$m", 0] }
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
                            },
                            // Exclude batches & imeis for security and light-speed payload
                            variants: {
                                $map: {
                                    input: "$variants",
                                    as: "v",
                                    in: {
                                        title: "$$v.title",
                                        barcode: { $ifNull: ["$$v.barcode", ""] },
                                        quantity: { $ifNull: ["$$v.quantity", 0] },
                                        retailPrice: { $ifNull: ["$$v.retailPrice", 0] },
                                        mrp: { $ifNull: ["$$v.mrp", 0] },
                                        combination: { $ifNull: ["$$v.combination", []] },
                                        attributes: { $ifNull: ["$$v.attributes", []] }
                                    }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            minRetailPrice: { $ifNull: [{ $min: "$validRetailPrices" }, 0] },
                            maxRetailPrice: { $ifNull: [{ $max: "$validRetailPrices" }, 0] },
                            minMrp: { $ifNull: [{ $min: "$validMrps" }, 0] },
                            maxMrp: { $ifNull: [{ $max: "$validMrps" }, 0] }
                        }
                    },
                    {
                        $addFields: {
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
                            }
                        }
                    },
                    {
                        $project: {
                            categoryDoc: 0,
                            validRetailPrices: 0,
                            validMrps: 0
                        }
                    }
                ];

                if (isExplicitlyUnpaginated) {
                    const unpaginatedPipeline = [...pipeline, ...projectProductDetailsStages];
                    const products = await productCollection.aggregate(unpaginatedPipeline).toArray();
                    return res.send(products);
                }

                // High-performance facet pagination: lookup only on the paginated slice
                pipeline.push({
                    $facet: {
                        metadata: [{ $count: "total" }],
                        products: [
                            { $skip: skipNum },
                            { $limit: limitNum },
                            ...projectProductDetailsStages
                        ]
                    }
                });

                const [facetResult] = await productCollection.aggregate(pipeline).toArray();
                const totalProductCounts = facetResult?.metadata?.[0]?.total || 0;
                const products = facetResult?.products || [];
                const totalPages = Math.ceil(totalProductCounts / limitNum) || 1;

                res.send({
                    products,
                    totalProductCounts,
                    totalPages,
                    currentPage: pageNum,
                    limit: limitNum
                });
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
                let query = { status: "active" };
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
                const { status } = req.query;
                const query = {};
                if (status && status !== "all") {
                    query.status = status;
                }
                const projection = { projection: { name: 1, productType: 1, status: 1 } };
                const result = await productCollection.find(query, projection).toArray();
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
                        status: 1,
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

                if (product.status && product.status !== "active") {
                    return res.status(400).send({ message: `"${product.name || 'Product'}" is inactive and cannot be sold` });
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

        // GET /product/:id -> High-performance aggregated product details with category, enriched batches, IMEIs, and valuation metrics


        // Primary route: GET /product/:id
        app.get("/product/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID format" });
                }
                const objectId = new ObjectId(id);

                const pipeline = [
                    // 1. Target single product by primary key index (_id)
                    { $match: { _id: objectId } },

                    // 2. Lookup Category details (handling ObjectId, string ID, or name)
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

                    // 3. Extract all unique supplier IDs from all variant batches for batch-supplier lookup
                    {
                        $lookup: {
                            from: "suppliers",
                            let: {
                                supplierIds: {
                                    $reduce: {
                                        input: { $ifNull: ["$variants", []] },
                                        initialValue: [],
                                        in: {
                                            $concatArrays: [
                                                "$$value",
                                                {
                                                    $map: {
                                                        input: { $ifNull: ["$$this.batches", []] },
                                                        as: "b",
                                                        in: "$$b.supplierId"
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                }
                            },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $in: ["$_id", "$$supplierIds"] },
                                                {
                                                    $in: [
                                                        { $toString: "$_id" },
                                                        {
                                                            $map: {
                                                                input: {
                                                                    $filter: {
                                                                        input: "$$supplierIds",
                                                                        as: "s",
                                                                        cond: { $ne: ["$$s", null] }
                                                                    }
                                                                },
                                                                as: "sid",
                                                                in: { $toString: "$$sid" }
                                                            }
                                                        }
                                                    ]
                                                }
                                            ]
                                        }
                                    }
                                },
                                {
                                    $project: {
                                        _id: 1,
                                        name: 1,
                                        phone: 1,
                                        email: 1,
                                        contactPerson: 1
                                    }
                                }
                            ],
                            as: "suppliersDoc"
                        }
                    },

                    // 4. Transform and enrich variants, batches, and IMEIs
                    {
                        $addFields: {
                            categoryDetails: { $ifNull: [{ $arrayElemAt: ["$categoryDoc", 0] }, null] },
                            categoryName: {
                                $ifNull: [{ $arrayElemAt: ["$categoryDoc.name", 0] }, "Uncategorized"]
                            },
                            variants: {
                                $map: {
                                    input: { $ifNull: ["$variants", []] },
                                    as: "v",
                                    in: {
                                        $let: {
                                            vars: {
                                                enrichedBatches: {
                                                    $map: {
                                                        input: { $ifNull: ["$$v.batches", []] },
                                                        as: "b",
                                                        in: {
                                                            $let: {
                                                                vars: {
                                                                    matchedSup: {
                                                                        $arrayElemAt: [
                                                                            {
                                                                                $filter: {
                                                                                    input: "$suppliersDoc",
                                                                                    as: "sup",
                                                                                    cond: {
                                                                                        $or: [
                                                                                            { $eq: ["$$sup._id", "$$b.supplierId"] },
                                                                                            {
                                                                                                $and: [
                                                                                                    { $ne: ["$$b.supplierId", null] },
                                                                                                    { $eq: [{ $toString: "$$sup._id" }, { $toString: "$$b.supplierId" }] }
                                                                                                ]
                                                                                            }
                                                                                        ]
                                                                                    }
                                                                                }
                                                                            },
                                                                            0
                                                                        ]
                                                                    },
                                                                    remQty: { $toDouble: { $ifNull: ["$$b.remainingQuantity", 0] } },
                                                                    unitCost: { $toDouble: { $ifNull: ["$$b.purchasePrice", 0] } }
                                                                },
                                                                in: {
                                                                    batchId: { $ifNull: ["$$b.batchId", ""] },
                                                                    invoiceNo: { $ifNull: ["$$b.invoiceNo", ""] },
                                                                    supplierId: { $ifNull: ["$$b.supplierId", null] },
                                                                    supplierName: { $ifNull: ["$$matchedSup.name", "Default / Initial Supplier"] },
                                                                    supplierPhone: { $ifNull: ["$$matchedSup.phone", ""] },
                                                                    supplierEmail: { $ifNull: ["$$matchedSup.email", ""] },
                                                                    supplierContactPerson: { $ifNull: ["$$matchedSup.contactPerson", ""] },
                                                                    purchasePrice: "$$unitCost",
                                                                    receivedQuantity: { $toDouble: { $ifNull: ["$$b.receivedQuantity", 0] } },
                                                                    remainingQuantity: "$$remQty",
                                                                    totalCostValue: { $multiply: ["$$remQty", "$$unitCost"] },
                                                                    purchaseDate: { $ifNull: ["$$b.purchaseDate", "$$b.createdAt"] },
                                                                    createdAt: { $ifNull: ["$$b.createdAt", null] },
                                                                    imeis: { $ifNull: ["$$b.imeis", []] }
                                                                }
                                                            }
                                                        }
                                                    }
                                                },
                                                varQty: { $toDouble: { $ifNull: ["$$v.quantity", 0] } },
                                                retPrice: { $toDouble: { $ifNull: ["$$v.retailPrice", 0] } },
                                                mrpPrice: { $toDouble: { $ifNull: ["$$v.mrp", 0] } }
                                            },
                                            in: {
                                                $let: {
                                                    vars: {
                                                        varCostValue: {
                                                            $reduce: {
                                                                input: "$$enrichedBatches",
                                                                initialValue: 0,
                                                                in: { $add: ["$$value", { $ifNull: ["$$this.totalCostValue", 0] }] }
                                                            }
                                                        }
                                                    },
                                                    in: {
                                                        title: { $ifNull: ["$$v.title", "Standard"] },
                                                        combination: { $ifNull: ["$$v.combination", []] },
                                                        attributes: { $ifNull: ["$$v.attributes", []] },
                                                        barcode: { $ifNull: ["$$v.barcode", ""] },
                                                        quantity: "$$varQty",
                                                        retailPrice: "$$retPrice",
                                                        mrp: "$$mrpPrice",
                                                        batches: "$$enrichedBatches",
                                                        imeis: { $ifNull: ["$$v.imeis", []] },
                                                        inventoryCostValue: "$$varCostValue",
                                                        projectedRevenue: { $multiply: ["$$varQty", "$$retPrice"] },
                                                        avgCostPrice: {
                                                            $cond: [
                                                                { $gt: ["$$varQty", 0] },
                                                                { $round: [{ $divide: ["$$varCostValue", "$$varQty"] }, 2] },
                                                                {
                                                                    $cond: [
                                                                        { $gt: [{ $size: "$$enrichedBatches" }, 0] },
                                                                        { $arrayElemAt: ["$$enrichedBatches.purchasePrice", 0] },
                                                                        0
                                                                    ]
                                                                }
                                                            ]
                                                        },
                                                        marginAmount: {
                                                            $cond: [
                                                                { $gt: ["$$varQty", 0] },
                                                                { $round: [{ $subtract: ["$$retPrice", { $divide: ["$$varCostValue", "$$varQty"] }] }, 2] },
                                                                0
                                                            ]
                                                        },
                                                        marginPercentage: {
                                                            $cond: [
                                                                { $and: [{ $gt: ["$$varQty", 0] }, { $gt: ["$$retPrice", 0] }] },
                                                                {
                                                                    $round: [
                                                                        {
                                                                            $multiply: [
                                                                                {
                                                                                    $divide: [
                                                                                        { $subtract: ["$$retPrice", { $divide: ["$$varCostValue", "$$varQty"] }] },
                                                                                        "$$retPrice"
                                                                                    ]
                                                                                },
                                                                                100
                                                                            ]
                                                                        },
                                                                        2
                                                                    ]
                                                                },
                                                                0
                                                            ]
                                                        },
                                                        createdAt: "$$v.createdAt",
                                                        updatedAt: "$$v.updatedAt"
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },

                    // 5. Compute global inventory, prices, cost basis, and metrics across all variants
                    {
                        $addFields: {
                            totalStock: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: 0,
                                    in: { $add: ["$$value", { $ifNull: ["$$this.quantity", 0] }] }
                                }
                            },
                            variantsCount: { $size: "$variants" },
                            totalInventoryCost: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: 0,
                                    in: { $add: ["$$value", { $ifNull: ["$$this.inventoryCostValue", 0] }] }
                                }
                            },
                            totalProjectedRevenue: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: 0,
                                    in: { $add: ["$$value", { $ifNull: ["$$this.projectedRevenue", 0] }] }
                                }
                            },
                            validRetailPrices: {
                                $filter: {
                                    input: "$variants.retailPrice",
                                    as: "p",
                                    cond: { $gt: ["$$p", 0] }
                                }
                            },
                            validMrps: {
                                $filter: {
                                    input: "$variants.mrp",
                                    as: "m",
                                    cond: { $gt: ["$$m", 0] }
                                }
                            },
                            validPurchasePrices: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: [],
                                    in: {
                                        $concatArrays: [
                                            "$$value",
                                            {
                                                $filter: {
                                                    input: {
                                                        $map: {
                                                            input: { $ifNull: ["$$this.batches", []] },
                                                            as: "b",
                                                            in: "$$b.purchasePrice"
                                                        }
                                                    },
                                                    as: "cost",
                                                    cond: { $gt: ["$$cost", 0] }
                                                }
                                            }
                                        ]
                                    }
                                }
                            },
                            // Flatten all batches across variants for immediate table rendering
                            allBatches: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: [],
                                    in: {
                                        $concatArrays: [
                                            "$$value",
                                            {
                                                $map: {
                                                    input: { $ifNull: ["$$this.batches", []] },
                                                    as: "batch",
                                                    in: {
                                                        batchId: "$$batch.batchId",
                                                        invoiceNo: "$$batch.invoiceNo",
                                                        variantTitle: "$$this.title",
                                                        variantBarcode: "$$this.barcode",
                                                        supplierId: "$$batch.supplierId",
                                                        supplierName: "$$batch.supplierName",
                                                        supplierPhone: "$$batch.supplierPhone",
                                                        supplierEmail: "$$batch.supplierEmail",
                                                        purchasePrice: "$$batch.purchasePrice",
                                                        receivedQuantity: "$$batch.receivedQuantity",
                                                        remainingQuantity: "$$batch.remainingQuantity",
                                                        totalCostValue: "$$batch.totalCostValue",
                                                        purchaseDate: "$$batch.purchaseDate",
                                                        imeis: "$$batch.imeis"
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                }
                            },
                            // Flatten all active remaining IMEIs across variants for instant barcode scanner/inventory search
                            allImeis: {
                                $reduce: {
                                    input: "$variants",
                                    initialValue: [],
                                    in: {
                                        $concatArrays: [
                                            "$$value",
                                            {
                                                $map: {
                                                    input: { $ifNull: ["$$this.imeis", []] },
                                                    as: "im",
                                                    in: {
                                                        imei1: {
                                                            $cond: [
                                                                { $eq: [{ $type: "$$im" }, "string"] },
                                                                "$$im",
                                                                { $ifNull: ["$$im.imei1", "$$im.imei"] }
                                                            ]
                                                        },
                                                        imei2: {
                                                            $cond: [
                                                                { $eq: [{ $type: "$$im" }, "string"] },
                                                                "",
                                                                { $ifNull: ["$$im.imei2", ""] }
                                                            ]
                                                        },
                                                        variantTitle: "$$this.title",
                                                        variantBarcode: "$$this.barcode",
                                                        status: "available"
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    },

                    // 6. Compute price ranges, gross profit, margin, and stock status
                    {
                        $addFields: {
                            minRetailPrice: { $ifNull: [{ $min: "$validRetailPrices" }, 0] },
                            maxRetailPrice: { $ifNull: [{ $max: "$validRetailPrices" }, 0] },
                            minMrp: { $ifNull: [{ $min: "$validMrps" }, 0] },
                            maxMrp: { $ifNull: [{ $max: "$validMrps" }, 0] },
                            minPurchasePrice: { $ifNull: [{ $min: "$validPurchasePrices" }, 0] },
                            maxPurchasePrice: { $ifNull: [{ $max: "$validPurchasePrices" }, 0] },
                            batchesCount: { $size: "$allBatches" },
                            activeImeisCount: { $size: "$allImeis" },
                            projectedGrossProfit: { $subtract: ["$totalProjectedRevenue", "$totalInventoryCost"] }
                        }
                    },

                    // 7. Add human-friendly formatted ranges, sorted batches, and stock status
                    {
                        $addFields: {
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
                            grossProfitMargin: {
                                $cond: [
                                    { $gt: ["$totalProjectedRevenue", 0] },
                                    {
                                        $round: [
                                            {
                                                $multiply: [
                                                    { $divide: ["$projectedGrossProfit", "$totalProjectedRevenue"] },
                                                    100
                                                ]
                                            },
                                            2
                                        ]
                                    },
                                    0
                                ]
                            },
                            stockStatus: {
                                $cond: [
                                    { $gt: ["$totalStock", 10] },
                                    "inStock",
                                    {
                                        $cond: [
                                            { $gt: ["$totalStock", 0] },
                                            "lowStock",
                                            "outOfStock"
                                        ]
                                    }
                                ]
                            },
                            allBatches: {
                                $sortArray: {
                                    input: "$allBatches",
                                    sortBy: { purchaseDate: -1 }
                                }
                            }
                        }
                    },

                    // 8. Clean up intermediate lookup arrays and temporary price arrays
                    {
                        $project: {
                            categoryDoc: 0,
                            suppliersDoc: 0,
                            validRetailPrices: 0,
                            validMrps: 0,
                            validPurchasePrices: 0
                        }
                    }
                ];

                const [result] = await productCollection.aggregate(pipeline).toArray();
                if (!result) {
                    return res.status(404).send({ message: "Product not found" });
                }
                res.send(result);
            } catch (err) {
                console.error("Error fetching aggregated product details by ID:", err);
                res.status(500).send({ message: "Failed to fetch product details" });
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

        // POST /product -> Insert a new product into the catalog with server timestamps & default active status
        app.post("/product", async (req, res) => {
            try {
                const data = req.body;
                if (!data.status || typeof data.status !== 'string') {
                    data.status = "active";
                }
                data.createdAt = new Date();
                data.updatedAt = new Date();
                const result = await productCollection.insertOne(data);
                res.send(result);
            } catch (err) {
                console.error("Error creating product:", err);
                res.status(500).send({ message: "Failed to create product" });
            }
        });

        // PATCH /product/:id/status -> Update or toggle product active/inactive status
        app.patch("/product/:id/status", async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID format" });
                }
                if (!status || typeof status !== "string") {
                    return res.status(400).send({ message: "Valid status string is required" });
                }
                const normalizedStatus = status.trim().toLowerCase();
                const result = await productCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: normalizedStatus, updatedAt: new Date() } }
                );
                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "Product not found" });
                }
                res.send({ success: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, status: normalizedStatus });
            } catch (err) {
                console.error("Error updating product status:", err);
                res.status(500).send({ message: "Failed to update product status" });
            }
        });

        app.delete("/product/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid product ID format" });
                }

                const productObjectId = new ObjectId(id);

                // 1. Check if product exists in any purchase
                const hasPurchases = await purchaseCollection.findOne({
                    $or: [
                        { productId: id },
                        { productId: productObjectId },
                        { "items.productId": id },
                        { "items.productId": productObjectId }
                    ]
                });

                // 2. Check if product exists in any sale
                const hasSales = await salesCollection.findOne({
                    $or: [
                        { "items.productId": id },
                        { "items.productId": productObjectId }
                    ]
                });

                if (hasPurchases || hasSales) {
                    return res.status(400).send({
                        message: "Cannot delete this product because it has purchase or sales history. Deactivate or archive it instead."
                    });
                }

                // 3. Safe to delete only if no transaction history exists
                const result = await productCollection.deleteOne({ _id: productObjectId });
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to delete product", error: error.message });
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

        // GET /suppliers -> High-performance aggregation pipeline retrieving suppliers with product counts, stock metrics, & live search
        app.get("/suppliers", async (req, res) => {
            try {
                const { search, q } = req.query;
                const searchQuery = (search || q || "").trim();

                const pipeline = [];

                if (searchQuery) {
                    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    pipeline.push({
                        $match: {
                            $or: [
                                { name: regex },
                                { contactPerson: regex },
                                { phone: regex },
                                { email: regex },
                                { address: regex }
                            ]
                        }
                    });
                }

                pipeline.push(
                    {
                        $lookup: {
                            from: "products",
                            let: { supIdStr: { $toString: "$_id" }, supId: "$_id", supName: "$name" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $in: ["$$supIdStr", { $ifNull: ["$variants.batches.supplierId", []] }] },
                                                { $in: ["$$supId", { $ifNull: ["$variants.batches.supplierId", []] }] },
                                                { $and: [{ $ne: ["$$supName", null] }, { $ne: ["$$supName", ""] }, { $in: ["$$supName", { $ifNull: ["$variants.batches.supplier", []] }] }] }
                                            ]
                                        }
                                    }
                                },
                                {
                                    $project: {
                                        _id: 1,
                                        stockFromSupplier: {
                                            $reduce: {
                                                input: {
                                                    $reduce: {
                                                        input: { $ifNull: ["$variants", []] },
                                                        initialValue: [],
                                                        in: { $concatArrays: ["$$value", { $ifNull: ["$$this.batches", []] }] }
                                                    }
                                                },
                                                initialValue: 0,
                                                in: {
                                                    $cond: [
                                                        {
                                                            $or: [
                                                                { $eq: ["$$this.supplierId", "$$supIdStr"] },
                                                                { $eq: ["$$this.supplierId", "$$supId"] },
                                                                { $eq: ["$$this.supplier", "$$supName"] }
                                                            ]
                                                        },
                                                        { $add: ["$$value", { $toDouble: { $ifNull: ["$$this.remainingQuantity", 0] } }] },
                                                        "$$value"
                                                    ]
                                                }
                                            }
                                        }
                                    }
                                },
                                {
                                    $group: {
                                        _id: null,
                                        productsCount: { $sum: 1 },
                                        totalStock: { $sum: "$stockFromSupplier" }
                                    }
                                }
                            ],
                            as: "productStats"
                        }
                    },
                    {
                        $lookup: {
                            from: "purchases",
                            let: { supIdStr: { $toString: "$_id" }, supId: "$_id", supName: "$name" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $or: [
                                                { $eq: ["$supplierId", "$$supIdStr"] },
                                                { $eq: ["$supplierId", "$$supId"] },
                                                { $and: [{ $ne: ["$$supName", null] }, { $ne: ["$$supName", ""] }, { $eq: ["$supplier", "$$supName"] }] },
                                                { $and: [{ $ne: ["$$supName", null] }, { $ne: ["$$supName", ""] }, { $eq: ["$supplierName", "$$supName"] }] }
                                            ]
                                        }
                                    }
                                },
                                {
                                    $group: {
                                        _id: null,
                                        purchasesCount: { $sum: 1 },
                                        distinctProducts: { $addToSet: "$productId" }
                                    }
                                }
                            ],
                            as: "purchaseStats"
                        }
                    },
                    {
                        $addFields: {
                            pStats: { $arrayElemAt: ["$productStats", 0] },
                            purStats: { $arrayElemAt: ["$purchaseStats", 0] }
                        }
                    },
                    {
                        $addFields: {
                            productsCount: {
                                $max: [
                                    { $ifNull: ["$pStats.productsCount", 0] },
                                    { $size: { $ifNull: ["$purStats.distinctProducts", []] } }
                                ]
                            },
                            totalProducts: {
                                $max: [
                                    { $ifNull: ["$pStats.productsCount", 0] },
                                    { $size: { $ifNull: ["$purStats.distinctProducts", []] } }
                                ]
                            },
                            totalStock: { $ifNull: ["$pStats.totalStock", 0] },
                            purchasesCount: { $ifNull: ["$purStats.purchasesCount", 0] }
                        }
                    },
                    {
                        $project: {
                            productStats: 0,
                            purchaseStats: 0,
                            pStats: 0,
                            purStats: 0
                        }
                    },
                    {
                        $sort: { createdAt: -1, _id: -1 }
                    }
                );

                const result = await supplierCollection.aggregate(pipeline).toArray();
                res.send(result);
            } catch (err) {
                console.error("Error fetching suppliers:", err);
                res.status(500).send({ message: "Failed to fetch suppliers" });
            }
        });

        // GET /suppliers/names -> Retrieve supplier names and IDs only with optional search (lightweight for purchase dropdown menus)
        app.get("/suppliers/names", async (req, res) => {
            try {
                const { search, q } = req.query;
                const searchQuery = (search || q || "").trim();
                const query = {};
                if (searchQuery) {
                    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    query.$or = [{ name: regex }, { contactPerson: regex }, { phone: regex }];
                }
                const projection = { projection: { name: 1 } };
                const result = await supplierCollection.find(query, projection).toArray();
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
                if (!data.name || !data.name.trim()) {
                    return res.status(400).send({ message: "Supplier name is required" });
                }
                if (!data.phone || !data.phone.trim()) {
                    return res.status(400).send({ message: "Phone number is required" });
                }

                const existingSupplier = await supplierCollection.findOne({ _id: new ObjectId(id) });
                if (!existingSupplier) {
                    return res.status(404).send({ message: "Supplier not found" });
                }

                const trimmedName = data.name.trim();
                const query = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        name: trimmedName,
                        phone: data.phone.trim(),
                        contactPerson: (data.contactPerson || "").trim(),
                        address: (data.address || "").trim(),
                        email: (data.email || "").trim(),
                        notes: (data.notes || "").trim(),
                        updatedAt: new Date()
                    }
                };
                const result = await supplierCollection.updateOne(query, updateDoc);

                // If supplier name changed, sync purchase records referencing this supplier
                if (existingSupplier.name && existingSupplier.name !== trimmedName) {
                    await purchaseCollection.updateMany(
                        { $or: [{ supplierId: id }, { supplierId: new ObjectId(id) }, { supplier: existingSupplier.name }] },
                        { $set: { supplier: trimmedName, supplierName: trimmedName } }
                    ).catch(err => console.error("Error syncing purchase supplier references:", err));
                }

                res.send(result);
            } catch (err) {
                console.error("Error updating supplier:", err);
                res.status(500).send({ message: "Failed to update supplier" });
            }
        });

        // DELETE /supplier/:id -> Delete a supplier only if no products or purchases are linked to this supplier
        app.delete("/supplier/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid supplier ID format" });
                }

                // 1. Verify supplier exists
                const supplier = await supplierCollection.findOne({ _id: new ObjectId(id) });
                if (!supplier) {
                    return res.status(404).send({ message: "Supplier not found" });
                }

                // 2. Check if products in inventory were brought from this supplier (via batches)
                const supplierBatchMatches = [
                    { "variants.batches.supplierId": id },
                    { "variants.batches.supplierId": new ObjectId(id) }
                ];
                if (supplier.name) {
                    supplierBatchMatches.push({ "variants.batches.supplier": supplier.name });
                }

                // 3. Check if any purchase records exist for this supplier
                const purchaseMatches = [
                    { supplierId: id },
                    { supplierId: new ObjectId(id) }
                ];
                if (supplier.name) {
                    purchaseMatches.push({ supplier: supplier.name });
                    purchaseMatches.push({ supplierName: supplier.name });
                }

                const [assignedProductsCount, purchasesCount] = await Promise.all([
                    productCollection.countDocuments({ $or: supplierBatchMatches }),
                    purchaseCollection.countDocuments({ $or: purchaseMatches })
                ]);

                if (assignedProductsCount > 0 || purchasesCount > 0) {
                    const reasons = [];
                    if (assignedProductsCount > 0) {
                        reasons.push(`${assignedProductsCount} product(s) in catalog`);
                    }
                    if (purchasesCount > 0) {
                        reasons.push(`${purchasesCount} purchase invoice(s)`);
                    }
                    return res.status(400).send({
                        message: `Cannot delete supplier: ${reasons.join(" and ")} were brought from "${supplier.name}". Please reassign or delete these records first.`
                    });
                }

                // 4. Safe to delete
                const result = await supplierCollection.deleteOne({ _id: new ObjectId(id) });
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
