const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const md5 = require("md5");
const readline = require('readline');

const dataPath = 'api/numBricks.txt';
const backupPath = 'api/saveBricks.txt';

const app = express();

//Show Current Bricks and add One
app.get('/', (req, res) => {
    SuccessResponse(bricks,res,req);
});

//Add One Brick
app.get('/place/:id', (req, res) => {
    if(CheckOTP(req.params.id)) { PlaceBrick(res,req);}
    else { FailureResponse(res,req);}
});

function startServer() {
    const servers = [];

    try {
        // Create HTTPS server
        const httpsServer = https.createServer(
            {
                key: fs.readFileSync("../.ssl/key.pem"),
                cert: fs.readFileSync("../.ssl/cert.pem"),
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
function SuccessResponse(bricks,res,req){
    const d = new Date();
    let time = d.getTime()
    res.send(
        bricks.toString()+","+
        time.toString()
    );
}

function FailureResponse(res,req){
    console.log(`Error: Incorrect otp: ${req.params.id}`);
    res.send("Error");
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

function PlaceBrick(res,req)
{
    bricks += 1;
    fs.writeFile(dataPath, bricks.toString(), err => {
        if (err) {
            console.error('Error writing to file:', err);
            FailureResponse(res,req);
        }
        else {
            console.log(`Placed Brick ${bricks} on ID: ${req.params.id}`);
            SuccessResponse(bricks, res, req);
        }
    });
}

function SaveBricks(){
    fs.appendFile(backupPath, bricks.toString() + `\n`, err => {
        if (err) {
            console.error('Error writing to file:', err);
        }
        else {
            console.log(`Logged ${bricks} bricks`);
        }
    });
}

/// Console Prompt

const commands = {
    setbricks: (number) => {
        bricks = number;
        fs.writeFile(dataPath, bricks.toString(), err => {
            if (err) {
                console.error('Error writing to file:', err);
            }
            else {
                console.log(`Set bricks to ${bricks}`);
            }
        });
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