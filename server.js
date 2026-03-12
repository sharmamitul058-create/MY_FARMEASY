// Express backend for D3 Hackathon Website
// Provides: Auth (JWT), Crops CRUD, Settings CRUD, Market/Forecast mock data
// Storage: MongoDB via Mongoose (previously JSON files)

const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
require('dotenv').config()

// DB
const { connectDB } = require('./server/src/utils/db')
const User = require('./server/src/models/User')
const Crop = require('./server/src/models/Crop')
const Setting = require('./server/src/models/Setting')
const Order = require('./server/src/models/Order')
const Notification = require('./server/src/models/Notification')
const { recommendBuyersForCrop, recommendCropsForOrder } = require('./server/src/utils/recommendation')
const { geocodeLocation } = require('./server/src/utils/geocode')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const DEFAULT_LOCATION_LABEL = 'Location not provided'

// Middleware
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

// Auth helpers
function signToken(user) {
	// user may be a Mongoose doc; ensure plain object
	const id = user._id ? user._id.toString() : user.id
	return jwt.sign({ id, role: user.role, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' })
}

function authRequired(req, res, next) {
	const header = req.headers.authorization || ''
	const token = header.startsWith('Bearer ') ? header.slice(7) : null
	if (!token) return res.status(401).json({ error: 'Missing token' })
	try {
		const payload = jwt.verify(token, JWT_SECRET)
		req.user = payload
		next()
	} catch (e) {
		return res.status(401).json({ error: 'Invalid token' })
	}
}

// ============ Auth Routes ============
app.post('/api/auth/signup', async (req, res) => {
	try {
		const { role = 'farmer', name, fullName, email, password, farmLocation, location, address } = req.body || {}
		if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
		// Normalize incoming location from different fields and fall back when absent
		const locationCandidates = [location, address, farmLocation]
			.map((value) => (typeof value === 'string' ? value.trim() : ''))
			.filter(Boolean)
		const normalizedLocation = locationCandidates[0] || ''
		const hasLocation = Boolean(normalizedLocation)
		if (!hasLocation) {
			console.warn('Signup received without location data', { email, role })
		}
		const fallbackLocation = hasLocation ? normalizedLocation : DEFAULT_LOCATION_LABEL
		const existing = await User.findOne({ email: String(email).toLowerCase() }).lean()
		if (existing) return res.status(409).json({ error: 'Email already registered' })

		let farmCoordinates = null
		let profileCoordinates = null
		let farmLocationString = role === 'buyer' ? '' : fallbackLocation
		let profileLocationString = role === 'buyer' ? fallbackLocation : (hasLocation ? '' : DEFAULT_LOCATION_LABEL)
		if (hasLocation) {
			try {
				const coords = await geocodeLocation(normalizedLocation)
				if (coords) {
					const { lat, lon, formattedAddress } = coords
					const coordPair =
						typeof lat === 'number' && typeof lon === 'number'
							? { lat, lon }
							: null
					if (role === 'buyer') {
						profileCoordinates = coordPair
						if (formattedAddress) profileLocationString = formattedAddress
					} else {
						farmCoordinates = coordPair
						if (formattedAddress) farmLocationString = formattedAddress
					}
				}
			} catch (geoErr) {
				console.warn('Failed to geocode signup location', geoErr?.message || geoErr)
			}
		}

		const passwordHash = await bcrypt.hash(String(password), 10)
		const user = await User.create({
			role: role === 'buyer' ? 'buyer' : 'farmer',
			name: name || fullName || 'User',
			email: String(email).toLowerCase(),
			passwordHash,
		})

		// Create default settings entry
		await Setting.create({
			userId: user._id,
			farm: {
				name: 'My Farm',
				location: farmLocationString,
				...(farmCoordinates ? { coordinates: farmCoordinates } : {}),
				acreage: 0,
				contact: user.name,
			},
			profile: {
				email: user.email,
				phone: '',
				location: profileLocationString,
				...(profileCoordinates ? { coordinates: profileCoordinates } : {}),
			},
			notifications: { priceChanges: true, weather: true, marketOpportunities: true, cropAlerts: true },
		})

		const token = signToken(user)
		res.status(201).json({ token, user: { id: user._id, role: user.role, name: user.name, email: user.email } })
	} catch (e) {
		res.status(500).json({ error: 'Signup failed' })
	}
})

app.post('/api/auth/login', async (req, res) => {
	try {
		const { email, password } = req.body || {}
		if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
		const user = await User.findOne({ email: String(email).toLowerCase() })
		if (!user) return res.status(404).json({ error: 'User not found' })
		const ok = await bcrypt.compare(String(password), user.passwordHash)
		if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
		const token = signToken(user)
		res.json({ token, user: { id: user._id, role: user.role, name: user.name, email: user.email } })
	} catch (e) {
		res.status(500).json({ error: 'Login failed' })
	}
})

app.get('/api/me', authRequired, async (req, res) => {
	try {
		const user = await User.findById(req.user.id).lean()
		if (!user) return res.status(404).json({ error: 'User not found' })
		res.json({ id: user._id, role: user.role, name: user.name, email: user.email })
	} catch (e) {
		res.status(500).json({ error: 'Failed to fetch user' })
	}
})

// ============ Crops (Farmer) ============
app.get('/api/crops', authRequired, async (req, res) => {
	try {
		const crops = await Crop.find({ userId: req.user.id }).lean()
		res.json(crops)
	} catch (e) {
		res.status(500).json({ error: 'Failed to load crops' })
	}
})

app.post('/api/crops', authRequired, async (req, res) => {
	try {
		const { name, acreage = 0, status = 'Planted', yourPrice = 0, marketPrice = 0, icon = '🌱', quantity = 0, quantityUnit = 'kg', priceUnit = 'rupees/kg' } = req.body || {}
		if (!name) return res.status(400).json({ error: 'name is required' })
		const crop = await Crop.create({ userId: req.user.id, name, acreage, status, yourPrice, marketPrice, icon, quantity, quantityUnit, priceUnit })
		const plain = crop.toObject({ virtuals: false })
		let recommendations = []
		try {
			recommendations = await recommendBuyersForCrop(crop)
		} catch (recErr) {
			console.error('Failed to compute buyer recommendations', recErr)
		}
		res.status(201).json({
			...plain,
			id: plain._id?.toString?.() || String(plain._id),
			recommendations,
		})
	} catch (e) {
		res.status(500).json({ error: 'Failed to create crop' })
	}
})

app.put('/api/crops/:id', authRequired, async (req, res) => {
	try {
		const id = req.params.id
		const updated = await Crop.findOneAndUpdate({ _id: id, userId: req.user.id }, { $set: req.body }, { new: true })
		if (!updated) return res.status(404).json({ error: 'Crop not found' })
		res.json(updated)
	} catch (e) {
		res.status(500).json({ error: 'Failed to update crop' })
	}
})

app.delete('/api/crops/:id', authRequired, async (req, res) => {
	try {
		const id = req.params.id
		const deleted = await Crop.findOneAndDelete({ _id: id, userId: req.user.id })
		if (!deleted) return res.status(404).json({ error: 'Crop not found' })
		res.json({ success: true })
	} catch (e) {
		res.status(500).json({ error: 'Failed to delete crop' })
	}
})

app.get('/api/crops/:id/recommendations', authRequired, async (req, res) => {
	try {
		const id = req.params.id
		const crop = await Crop.findOne({ _id: id, userId: req.user.id })
		if (!crop) return res.status(404).json({ error: 'Crop not found' })
		const limitParam = Number(req.query.limit)
		const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(20, Math.trunc(limitParam))) : undefined
		const recommendations = await recommendBuyersForCrop(crop, { limit })
		res.json({ cropId: crop._id.toString(), recommendations })
	} catch (e) {
		console.error('Failed to load crop recommendations', e)
		res.status(500).json({ error: 'Failed to load recommendations' })
	}
})

// ============ Settings (Farmer) ============
app.get('/api/settings', authRequired, async (req, res) => {
	try {
		const s = await Setting.findOne({ userId: req.user.id }).lean()
		if (!s) return res.json({ userId: req.user.id, farm: {}, profile: {}, notifications: {} })
		res.json(s)
	} catch (e) {
		res.status(500).json({ error: 'Failed to load settings' })
	}
})

app.put('/api/settings', authRequired, async (req, res) => {
	try {
		const incoming = req.body || {}
		const updated = await Setting.findOneAndUpdate(
			{ userId: req.user.id },
			{ $set: { ...incoming, userId: req.user.id } },
			{ new: true, upsert: true }
		)
		res.json(updated)
	} catch (e) {
		res.status(500).json({ error: 'Failed to update settings' })
	}
})

// ============ Market & Forecasts (Mock) ============
// Public list of farmer offers (crops) for buyers
app.get('/api/offers', async (req, res) => {
		try {
			// Optionally allow simple search by crop name via ?q=
			const q = (req.query.q || '').toString().trim().toLowerCase()
			const criteria = q ? { name: { $regex: q, $options: 'i' } } : {}
			const crops = await Crop.find(criteria).lean()

			// Load user info for farmer name and filter to farmer role only
			const userIds = [...new Set(crops.map(c => String(c.userId)))]
			const users = await User.find({ _id: { $in: userIds } }).select('_id name role').lean()
			const settings = await Setting.find({ userId: { $in: userIds } }).select('userId farm profile').lean()
			const userMap = new Map(users.map(u => [String(u._id), u]))
			const settingMap = new Map(settings.map(s => [String(s.userId), s]))

			const results = crops
				.filter(c => (userMap.get(String(c.userId))?.role || 'farmer') === 'farmer')
				.map(c => {
				const u = userMap.get(String(c.userId))
				const setting = settingMap.get(String(c.userId))
			const quantityAmount = Number(c.quantity || 0)
			const quantityUnit = c.quantityUnit || 'kg'
			const priceAmount = Number(c.yourPrice || 0)
			// Normalize priceUnit labels to UI style
			const priceUnit = c.priceUnit === 'rupees/ton' ? 'Rs./ton' : 'Rs./kg'
			const quantityDisplay = quantityAmount ? `${quantityAmount} ${quantityUnit}` : `${c.acreage || 0} acres`
			const priceDisplay = priceAmount ? `${priceAmount} ${priceUnit}` : ''
			return {
				id: String(c._id),
				title: c.name,
				quantityAmount,
				quantityUnit,
				quantityDisplay,
				priceAmount,
				priceUnit,
				priceDisplay,
				farmer: u?.name || 'Farmer',
				farmerLocation: setting?.farm?.location || setting?.profile?.location || '',
				image: 'https://images.unsplash.com/photo-1542834369-f10ebf06d3cb?w=200&h=200&fit=crop',
			}
			})

		res.json(results)
	} catch (e) {
		console.error('Failed to load offers', e)
		res.status(500).json({ error: 'Failed to load offers' })
	}
})

// ============ Orders (Buyer) ============
// Create a purchase offer (order) by buyer
app.post('/api/orders', authRequired, async (req, res) => {
	try {
		const { cropType, quantityAmount, quantityUnit = 'kg', priceAmount, priceUnit = 'Rs./kg' } = req.body || {}
		if (!cropType) return res.status(400).json({ error: 'cropType is required' })
		const qAmt = Number(quantityAmount)
		const pAmt = Number(priceAmount)
		if (!Number.isFinite(qAmt) || qAmt < 0) return res.status(400).json({ error: 'quantityAmount must be a non-negative number' })
		if (!Number.isFinite(pAmt) || pAmt < 0) return res.status(400).json({ error: 'priceAmount must be a non-negative number' })

		const normalizedPriceUnit = priceUnit === 'Rs./ton' ? 'rupees/ton' : 'rupees/kg'
		const order = await Order.create({
			buyerId: req.user.id,
			cropType: String(cropType),
			quantityAmount: qAmt,
			quantityUnit: quantityUnit === 'ton' ? 'ton' : 'kg',
			priceAmount: pAmt,
			priceUnit: normalizedPriceUnit,
			status: 'Pending',
		})

		const out = {
			id: order._id,
			cropType: order.cropType,
			quantityAmount: order.quantityAmount,
			quantityUnit: order.quantityUnit,
			quantityDisplay: `${order.quantityAmount} ${order.quantityUnit}`,
			priceAmount: order.priceAmount,
			priceUnit: order.priceUnit === 'rupees/ton' ? 'Rs./ton' : 'Rs./kg',
			priceDisplay: `${order.priceAmount} ${order.priceUnit === 'rupees/ton' ? 'Rs./ton' : 'Rs./kg'}`,
			status: order.status,
			createdAt: order.createdAt,
		}
		let recommendations = []
		try {
			recommendations = await recommendCropsForOrder(order)
		} catch (recErr) {
			console.error('Failed to compute crop recommendations', recErr)
		}
		res.status(201).json({ ...out, recommendations })
	} catch (e) {
		console.error('Failed to create order', e)
		res.status(500).json({ error: 'Failed to create order' })
	}
})

// List orders for the current buyer
app.get('/api/orders', authRequired, async (req, res) => {
	try {
		const orders = await Order.find({ buyerId: req.user.id }).sort({ createdAt: -1 }).lean()
		const result = orders.map(o => ({
			id: String(o._id),
			cropType: o.cropType,
			quantityAmount: o.quantityAmount,
			quantityUnit: o.quantityUnit,
			quantityDisplay: `${o.quantityAmount} ${o.quantityUnit}`,
			priceAmount: o.priceAmount,
			priceUnit: o.priceUnit === 'rupees/ton' ? 'Rs./ton' : 'Rs./kg',
			priceDisplay: `${o.priceAmount} ${o.priceUnit === 'rupees/ton' ? 'Rs./ton' : 'Rs./kg'}`,
			status: o.status,
			createdAt: o.createdAt,
		}))
		res.json(result)
	} catch (e) {
		console.error('Failed to load orders', e)
		res.status(500).json({ error: 'Failed to load orders' })
	}
})

app.get('/api/orders/:id/recommendations', authRequired, async (req, res) => {
	try {
		const id = req.params.id
		const order = await Order.findOne({ _id: id, buyerId: req.user.id })
		if (!order) return res.status(404).json({ error: 'Order not found' })
		const limitParam = Number(req.query.limit)
		const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(20, Math.trunc(limitParam))) : undefined
		const recommendations = await recommendCropsForOrder(order, { limit })
		res.json({ orderId: order._id.toString(), recommendations })
	} catch (e) {
		console.error('Failed to load order recommendations', e)
		res.status(500).json({ error: 'Failed to load recommendations' })
	}
})

// ============ Notifications ============
app.get('/api/notifications', authRequired, async (req, res) => {
	try {
		const notifications = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean()
		const results = notifications.map((n) => ({
			id: String(n._id),
			type: n.type,
			message: n.message,
			metadata: n.metadata || {},
			read: Boolean(n.read),
			readAt: n.readAt,
			createdAt: n.createdAt,
			senderName: n.senderName || '',
		}))
		res.json(results)
	} catch (e) {
		console.error('Failed to fetch notifications', e)
		res.status(500).json({ error: 'Failed to load notifications' })
	}
})

app.post('/api/notifications/contact', authRequired, async (req, res) => {
	try {
		if (req.user.role !== 'farmer') {
			return res.status(403).json({ error: 'Only farmers can contact buyers' })
		}
		const { buyerId, orderId, cropName } = req.body || {}
		if (!buyerId) return res.status(400).json({ error: 'buyerId is required' })
		const buyer = await User.findById(buyerId).lean()
		if (!buyer || buyer.role !== 'buyer') {
			return res.status(404).json({ error: 'Buyer not found' })
		}

		let order = null
		if (orderId) {
			order = await Order.findOne({ _id: orderId, buyerId: buyer._id }).lean()
		}

		const resolvedCrop = cropName || order?.cropType || 'your offer'
		const senderName = req.user.name || 'A farmer'
		const message = `${senderName} is interested in your offer for ${resolvedCrop}.`

		const notification = await Notification.create({
			userId: buyer._id,
			senderId: req.user.id,
			senderName,
			type: 'buyer-offer-interest',
			message,
			metadata: {
				orderId: order?._id ? order._id.toString() : orderId || null,
				cropName: resolvedCrop,
				farmerId: req.user.id,
				farmerName: senderName,
			},
		})

		res.status(201).json({
			id: notification._id.toString(),
			message: notification.message,
			createdAt: notification.createdAt,
		})
	} catch (e) {
		console.error('Failed to create notification', e)
		res.status(500).json({ error: 'Failed to notify buyer' })
	}
})

app.post('/api/notifications/mark-read', authRequired, async (req, res) => {
	try {
		const { ids = [] } = req.body || {}
		if (!Array.isArray(ids) || !ids.length) {
			return res.json({ success: true, updated: 0 })
		}
		const result = await Notification.updateMany(
			{ _id: { $in: ids }, userId: req.user.id },
			{ $set: { read: true, readAt: new Date() } }
		)
		const updated = typeof result.modifiedCount === 'number' ? result.modifiedCount : (typeof result.nModified === 'number' ? result.nModified : 0)
		res.json({ success: true, updated })
	} catch (e) {
		console.error('Failed to mark notifications as read', e)
		res.status(500).json({ error: 'Failed to update notifications' })
	}
})

// Delete an order for the current buyer
app.delete('/api/orders/:id', authRequired, async (req, res) => {
    try {
        const id = req.params.id
        const deleted = await Order.findOneAndDelete({ _id: id, buyerId: req.user.id })
        if (!deleted) return res.status(404).json({ error: 'Order not found' })
        res.json({ success: true })
    } catch (e) {
        console.error('Failed to delete order', e)
        res.status(500).json({ error: 'Failed to delete order' })
    }
})

app.get('/api/market/opportunities', (req, res) => {
	const data = [
		{ icon: '🌾', buyer: 'Buyer A', crop: 'Wheat', price: 100, distance: 10 },
		{ icon: '🌽', buyer: 'Buyer B', crop: 'Corn', price: 150, distance: 15 },
		{ icon: '🫘', buyer: 'Buyer C', crop: 'Soybeans', price: 200, distance: 20 },
	]
	res.json(data)
})

app.get('/api/market/trends', (req, res) => {
	const crop = (req.query.crop || 'Wheat').toString()
	const series = {
		Wheat: [
			{ year: 2018, avgPrice: 8.5 },
			{ year: 2019, avgPrice: 8.75 },
			{ year: 2020, avgPrice: 9.0 },
			{ year: 2021, avgPrice: 9.25 },
			{ year: 2022, avgPrice: 9.5 },
		],
		Corn: [
			{ year: 2018, avgPrice: 7.25 },
			{ year: 2019, avgPrice: 7.5 },
			{ year: 2020, avgPrice: 7.75 },
			{ year: 2021, avgPrice: 8.0 },
			{ year: 2022, avgPrice: 8.25 },
		],
		Soybean: [
			{ year: 2018, avgPrice: 12.5 },
			{ year: 2019, avgPrice: 12.75 },
			{ year: 2020, avgPrice: 13.0 },
			{ year: 2021, avgPrice: 13.25 },
			{ year: 2022, avgPrice: 13.5 },
		],
	}
	res.json(series[crop] || series['Wheat'])
})

app.get('/api/forecasts/prices', (req, res) => {
	// simple mock forecast for 30 days
	const crop = (req.query.crop || 'Wheat').toString()
	const base = 120
	const data = Array.from({ length: 30 }).map((_, i) => ({ day: i + 1, crop, price: base + i * 3 + Math.round(Math.random() * 5) }))
	res.json(data)
})

// Reverse geocode coordinates to a human-friendly location (city, state, formatted)
app.get('/api/geocode/reverse', async (req, res) => {
	try {
		const lat = Number(req.query.lat)
		const lon = Number(req.query.lon)
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon are required' })
		const { reverseGeocode } = require('./server/src/utils/geocode')
		const out = await reverseGeocode(lat, lon)
		if (!out) return res.status(204).end()
		res.json(out)
	} catch (e) {
		console.error('Reverse geocode failed', e)
		res.status(500).json({ error: 'Reverse geocode failed' })
	}
})

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Fallback: redirect to homepage so relative assets resolve (e.g., home.css)
app.get('/', (req, res) => {
	const rel = '/Homepage/homeindex.html'
	return res.redirect(rel)
})

// Legacy asset aliases to support previously cached root-loaded homepage
app.get('/home.css', (req, res) => {
	const file = path.join(__dirname, 'Homepage', 'home.css')
	if (fs.existsSync(file)) return res.sendFile(file)
	return res.status(404).send('Not found')
})
app.get('/home.js', (req, res) => {
	const file = path.join(__dirname, 'Homepage', 'home.js')
	if (fs.existsSync(file)) return res.sendFile(file)
	return res.status(404).send('Not found')
})

// Serve static frontend (all folders under project root) AFTER API routes
app.use(express.static(__dirname))

// Start server only after DB is connected
async function start() {
	try {
		await connectDB()
		app.listen(PORT, () => {
			console.log(`Server listening on http://localhost:${PORT}`)
		})
	} catch (e) {
		console.error('Failed to start server', e)
		process.exit(1)
	}
}

if (require.main === module) {
	start()
}

module.exports = { app, start }

