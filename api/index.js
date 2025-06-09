const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const md5 = require("md5");

const dataPath = 'api/numBricks.txt';

const app = express();

// Create an HTTPS service.
https.createServer(
        // Provide the private and public key to the server by reading each
        // file's content with the readFileSync() method.
        {
        key: fs.readFileSync("../.ssl/key.pem"),
        cert: fs.readFileSync("../.ssl/cert.pem"),
        },
        app
    )
    .listen(443, () => {
    console.log(`Server listening on port 443`);
});

// Create an HTTP service.
http.createServer(app).listen(80, () => {
    console.log(`Server listening on port 80`);
});

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

// Initialize Bricks
let bricks = 0;
try {
  const data = fs.readFileSync(dataPath, 'utf8');
  bricks = parseInt(data) || 0;
  console.log(`Read Bricks from File: ${bricks}`);
} catch (err) {
  console.error('Error reading bricks file:', err);
}

//Show Current Bricks and add One
app.get('/', (req, res) => {
    SuccessResponse(bricks,res,req);
});

//Add One Brick
app.get('/place/:id', (req, res) => {
    if(CheckOTP(req.params.id)) { PlaceBrick(res,req);}
    else { FailureResponse(res,req);}
});

//This is not a security-critical application, I just need a stable hash
const keyPath = 'api/key.txt';
const otpkey = fs.readFileSync(keyPath, 'utf-8');
const interval = 10;
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