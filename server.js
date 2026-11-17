const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

// Modern Modular Imports for Firebase Admin SDK
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin Initialization
let db = null;
try {
    const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

    if (getApps().length === 0) {
        initializeApp({
            credential: cert(serviceAccount)
        });
    }

    db = getFirestore();
    console.log("SUCCESS: Connected to Firebase Cloud Firestore");
} catch (err) {
    console.error("FIREBASE ERROR DETAILS:", err.message);
    console.log("Firebase Service Account key not found or invalid. Using local memory fallback.");
}

// Local Memory Store Fallback
let memoryStore = { patients: [], alarms: [], vitals: [] };

// Keyword Routing for Doctors
function assignDoctor(diagnosis) {
    if (!diagnosis) return "Dr. Amit Sharma";
    const d = diagnosis.toLowerCase();
    if (d.includes("fever")) return "Dr. Amit Sharma";
    if (d.includes("pain")) return "Dr. Sudha Nayak";
    if (d.includes("heart")) return "Dr. Radha Singh";
    return "Dr. Amit Sharma";
}

// REST ENDPOINTS

// 1. Patient Check-In
app.post('/api/patient/checkin', async (req, res) => {
    const { name, mobile, email, diagnosis, bedNo } = req.body;
    const patientId = "P-" + Math.floor(1000 + Math.random() * 9000);
    const assignedDoctor = assignDoctor(diagnosis);

    const record = {
        patientId, name, mobile, email, diagnosis, bedNo, assignedDoctor,
        status: 'Active', createdAt: new Date().toISOString()
    };

    if (db) {
        await db.collection('patients').doc(patientId).set(record);
    } else {
        memoryStore.patients.push(record);
    }

    res.json({ success: true, patient: record });
});

// 2. Fetch Latest Active Patient for Dashboard
app.get('/api/patient/latest', async (req, res) => {
    if (db) {
        const snap = await db.collection('patients').where('status', '==', 'Active').orderBy('createdAt', 'desc').limit(1).get();
        if (!snap.empty) return res.json(snap.docs[0].data());
    }
    const active = memoryStore.patients.filter(p => p.status === 'Active');
    res.json(active[active.length - 1] || null);
});

// 3. Fetch ALL Active Patients List
app.get('/api/all-patients', async (req, res) => {
    if (db) {
        const snap = await db.collection('patients').where('status', '==', 'Active').get();
        return res.json(snap.docs.map(d => d.data()));
    }
    const active = memoryStore.patients.filter(p => p.status === 'Active');
    res.json(active);
});

// 4. Fetch Doctor Assigned Patients
app.get('/api/doctor/patients', async (req, res) => {
    const doctorName = req.query.doctorName || '';
    if (db) {
        const activeSnap = await db.collection('patients').where('assignedDoctor', '==', doctorName).where('status', '==', 'Active').get();
        return res.json({ active: activeSnap.docs.map(d => d.data()) });
    }
    const active = memoryStore.patients.filter(p => p.assignedDoctor === doctorName && p.status === 'Active');
    res.json({ active });
});

// 5. Submit Manual Vitals Entry
app.post('/api/vitals/manual', async (req, res) => {
    const { patientId, heartRate, spo2, temp } = req.body;
    const isStable = (heartRate >= 60 && heartRate <= 100) && (spo2 >= 95) && (temp >= 36.0 && temp <= 37.5);
    const vitalsData = {
        patientId,
        mode: 'MANUAL',
        heartRate,
        spo2,
        temp,
        isStable,
        timestamp: new Date().toISOString()
    };

    if (db) {
        await db.collection('vitals_history').add(vitalsData);
    } else {
        memoryStore.vitals.push(vitalsData);
    }

    broadcast({ type: 'MANUAL_VITALS_STREAM', ...vitalsData });
    res.json({ success: true, isStable });
});

// 6. Fetch Patient Vitals History Logs
app.get('/api/vitals/history', async (req, res) => {
    const patientId = req.query.patientId;
    if (db) {
        try {
            const snap = await db.collection('vitals_history')
                .where('patientId', '==', patientId)
                .get();
            let docs = snap.docs.map(d => d.data());
            docs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            return res.json(docs);
        } catch (e) {
            return res.json([]);
        }
    }
    const history = memoryStore.vitals
        .filter(v => v.patientId === patientId)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(history);
});

// 7. Trigger SOS Alert
app.post('/api/sos/trigger', async (req, res) => {
    const { patientId, name, bedNo, reason, mode } = req.body;
    const alert = {
        patientId, patientName: name, bedNo, reason, mode,
        timestamp: new Date().toLocaleString()
    };

    if (db) {
        await db.collection('alarms').add(alert);
    } else {
        memoryStore.alarms.unshift(alert);
    }

    broadcast({ type: 'SOS_EVENT', ...alert });
    res.json({ success: true });
});

// 8. Fetch Alarm History
app.get('/api/alarms', async (req, res) => {
    if (db) {
        const snap = await db.collection('alarms').get();
        let docs = snap.docs.map(d => d.data());
        return res.json(docs);
    }
    res.json(memoryStore.alarms);
});

// WEBSOCKET SERVER
const server = app.listen(PORT, () => console.log(`Smart Bed Backend active on http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
    });
}