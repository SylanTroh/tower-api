const md5 = require("md5");
const { Pool } = require('pg');

// Neon PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const otpkey = process.env.OTP_KEY; // Set this in Vercel environment variables
const interval = 10;

function MD5Hash(str) {
    const hash = md5(str);
    return hash;
}

function CalculateCounter() {
    const d = new Date();
    let timeInSeconds = Math.floor(d.getTime() / 1000);
    return Math.floor(timeInSeconds / interval);
}

function CalculateOTP(counter) {
    let hashCode = MD5Hash(otpkey + counter);
    let firstFour = hashCode.slice(0, 4);
    let otp = Number("0x" + firstFour);
    otp = (otp & 511) + 1;
    return otp;
}

function CheckOTP(otp) {
    let counter = CalculateCounter();
    let currentOTP = CalculateOTP(counter);
    let prevOTP = CalculateOTP(counter - 1);
    return (otp == currentOTP) || (otp == prevOTP);
}

function SuccessResponse(bricks, res) {
    const d = new Date();
    let time = d.getTime();

    // Return the same format as original code
    res.status(200).send(bricks.toString() + "," + time.toString());
}

function FailureResponse(res) {
    res.status(400).send("Error");
}

// Database functions using Neon PostgreSQL
async function getBricks() {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query('SELECT count FROM bricks WHERE id = 1');
            return result.rows[0]?.count || 0;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error getting bricks:', error);
        return 0;
    }
}

async function incrementBricks() {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                INSERT INTO bricks (id, count) VALUES (1, 1)
                ON CONFLICT (id) DO UPDATE SET count = bricks.count + 1, updated_at = NOW()
                RETURNING count
            `);
            return result.rows[0].count;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error incrementing bricks:', error);
        throw error;
    }
}

// Main handler for Vercel
export default async function handler(req, res) {
    const { method, query } = req;

    // Enable CORS if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (query.place && query.id) {
            // Handle /place/:id route
            if (CheckOTP(query.id)) {
                const newBricks = await incrementBricks();
                console.log(`Placed Brick ${newBricks} on ID: ${query.id}`);
                SuccessResponse(newBricks, res);
            } else {
                console.log(`Error: Incorrect otp: ${query.id}`);
                FailureResponse(res);
            }
        } else {
            // Handle root route - show current bricks
            const currentBricks = await getBricks();
            SuccessResponse(currentBricks, res);
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal server error');
    }
}