const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const https = require('https');
const fs = require('fs');
const md5 = require("md5");
const readline = require('readline');

const dataPath = 'api/numBricks.txt';
const backupPath = 'api/saveBricks.txt';

const app = express();

// General rate limiter
const generalLimiter = rateLimit({
    windowMs: 14 * 1000,
    max: 3, // Limit each IP to 3 requests per 14 seconds
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 seconds'
    },
    standardHeaders: true,
    legacyHeaders: false, 
    keyGenerator: (req) => {
        return req.ip;
    }
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Write queue to handle race conditions
class WriteQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    async enqueue(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const { operation, resolve, reject } = this.queue.shift();

            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }

        this.isProcessing = false;
    }
}

const writeQueue = new WriteQueue();

//Show Current Bricks
app.get('/', (req, res) => {
    SuccessResponseBricks(bricks,res,req);
});

//Show Server Time
app.get('/time', (req, res) => {
    SuccessResponseTime(res,req);
});

//Add One Brick
app.get('/place/:id', (req, res) => {
    if(CheckOTP(req.params.id)) { PlaceBrick(1,res,req);}
    else { FailureResponse(res,req);}
});

//Add Two Bricks
app.get('/place2/:id', (req, res) => {
    if(CheckOTP(req.params.id)) { PlaceBrick(2,res,req);}
    else { FailureResponse(res,req);}
});

//Add Three Bricks
app.get('/place3/:id', (req, res) => {
    if(CheckOTP(req.params.id)) { PlaceBrick(3,res,req);}
    else { FailureResponse(res,req);}
});


function startServer() {
    const servers = [];

    try {
        // Create HTTPS server
        const httpsServer = https.createServer(
            {
                key: fs.readFileSync(".ssl/key.pem"),
                cert: fs.readFileSync(".ssl/cert.pem"),
            },
            app
        );

        httpsServer.listen(443, () => {
            console.log('HTTPS Server listening on port 443');
        });

        servers.push(httpsServer);
    } catch (error) {
        console.error('Failed to start HTTPS server:', error.message);
    }

    try {
        // Create HTTP server
        const httpServer = http.createServer(app);

        httpServer.listen(80, () => {
            console.log('HTTP Server listening on port 80');
        });

        servers.push(httpServer);
    } catch (error) {
        console.error('Failed to start HTTP server:', error.message);
    }

    return servers;
}

function SuccessResponseBricks(bricks, res, req) {
    res.status(200).send(bricks.toString());
}

function SuccessResponseTime(res, req) {
    const d = new Date();
    let time = d.getTime();
    res.status(200).send(time.toString());
}

function FailureResponse(res,req){
    console.log(`Error: Incorrect otp: ${req.params.id}`);
    res.status(400).send("<p>Hi! This is Sylan!<br>" +
        "If you're here, that means you're poking around at the server for my tower world.<br>" +
        "It's pretty cool that you've managed to get here, I myself love to tinker around with things and figure out how they work, but I would like to please ask you to consider the following before poking any further:<br>" +
        "I made this world because I wanted to make a fun experience that brings people together.<br>" +
        "To accomplish this, I pay for the server that makes this possible out of pocket, and I am more than willing to do so because it makes me happy to see others having fun.<br>" +
        "I don't make any money from this world. This means that if bots or users outside VR decide to flood the server with requests, I will likely not be able to afford to keep it running anymore, shutting it down for everyone.<br>" +
        "While I can't possibly know your intentions, I hope you can keep that in mind if you decide to continue poking around here.<br>" +
        "<br>" +
        "- Sylan</p>");
}

function MD5Hash(str) {
      const hash = md5(str);
      return hash;
}

function CalculateCounter(){
    const d = new Date();
    let timeInSeconds = Math.floor(d.getTime() / 1000);
    return Math.floor(timeInSeconds / interval);
}

function CalculateOTP(counter){
    let hashCode = MD5Hash(otpkey + counter);
    let firstFour = hashCode.slice(0,4);
    let otp = Number("0x"+firstFour);
    otp = (otp & 511) + 1;
    return otp;
}

function CheckOTP(otp){
    let counter = CalculateCounter()
    let currentOTP = CalculateOTP(counter);
    let prevOTP = CalculateOTP(counter-1);
    return (otp == currentOTP) || (otp == prevOTP)
}

async function PlaceBrick(num, res, req) {
    try {
        await writeQueue.enqueue(async () => {
            // Increment bricks in memory
            bricks += num;

            // Write to file using promises
            return new Promise((resolve, reject) => {
                fs.writeFile(dataPath, bricks.toString(), err => {
                    if (err) {
                        // Rollback the in-memory change on error
                        bricks -= num;
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });

        console.log(`Placed ${num} brick(s). Total: ${bricks} on ID: ${req.params.id}`);
        SuccessResponseBricks(bricks, res, req);
    } catch (error) {
        console.error('Error placing brick:', error);
        FailureResponse(res, req);
    }
}

async function SaveBricks(){
    try {
        await writeQueue.enqueue(async () => {
            return new Promise((resolve, reject) => {
                const timestamp = new Date().toISOString();
                const backupEntry = `${timestamp}: ${bricks}\n`;
                
                fs.appendFile(backupPath, backupEntry, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });

        console.log(`Logged ${bricks} bricks`);
    } catch (error) {
        console.error('Error saving bricks:', error);
    }
}

/// Console Prompt

const commands = {
    setbricks: async (number) => {
        const newBricks = parseInt(number);
        if (isNaN(newBricks)) {
            console.log('Invalid number provided');
            return;
        }

        try {
            await writeQueue.enqueue(async () => {
                bricks = newBricks;
                return new Promise((resolve, reject) => {
                    fs.writeFile(dataPath, bricks.toString(), err => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            });

            console.log(`Set bricks to ${bricks}`);
        } catch (error) {
            console.error('Error setting bricks:', error);
        }
    },

    time: () => {
        console.log(`Current time: ${new Date().toLocaleString()}`);
    },

    help: () => {
        console.log('\nAvailable commands:');
        Object.keys(commands).forEach(cmd => {
            console.log(`  ${cmd}`);
        });
    },

    exit: () => {
        console.log('Goodbye!');
        process.exit(0);
    }
};

// Create an interface for input and output
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Function to parse and execute commands
function executeCommand(input) {
    const args = input.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const params = args.slice(1);

    if (commands[command]) {
        try {
            commands[command](...params);
        } catch (error) {
            console.error(`Error executing command '${command}':`, error.message);
        }
    } else if (command === '') {
        // Do nothing for empty input
        return;
    } else {
        console.log(`Unknown command: '${command}'. Type 'help' for available commands.`);
    }
}

// Main CLI loop
function startCLI() {
    console.log('Simple CLI started. Type "help" for commands or "exit" to quit.\n');

    const prompt = () => {
        rl.question('> ', (input) => {
            executeCommand(input);
            prompt(); // Continue the loop
        });
    };

    // Override console methods to reprint prompt after logging
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    console.log = (...args) => {
        // Clear current line and move cursor to beginning
        process.stdout.write('\r\x1b[K');
        originalConsoleLog.apply(console, args);
        // Reprint the prompt
        process.stdout.write('> ');
    };

    console.error = (...args) => {
        // Clear current line and move cursor to beginning
        process.stdout.write('\r\x1b[K');
        originalConsoleError.apply(console, args);
        // Reprint the prompt
        process.stdout.write('> ');
    };

    prompt();
}

// Handle Ctrl+C gracefully
rl.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Goodbye!');
    process.exit(0);
});


// Initialize Bricks
let bricks = 0;
try {
    const data = fs.readFileSync(dataPath, 'utf8');
    bricks = parseInt(data) || 0;
    console.log(`Read Bricks from File: ${bricks}`);
} catch (err) {
    console.error('Error reading bricks file:', err);
}

//This is not a security-critical application, I just need a stable hash
const keyPath = 'api/key.txt';
const otpkey = fs.readFileSync(keyPath, 'utf-8').split(/\n/g)[0];
const interval = 10;

// Start The Server
console.log('Starting Server');
const servers = startServer();
startCLI();
const saveInterval = setInterval(SaveBricks, 5 * 60 * 1000);