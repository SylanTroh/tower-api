const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

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

// Initialize Bricks
let bricks = 0;
//Show Current Bricks and add One
app.get('/', (req, res) => {
    res.send(bricks.toString());
});
app.get('/bricks', (req, res) => {
    res.send(bricks.toString());
});

// Get current server time
app.get('/time', (req, res) => {
    const d = new Date();
    let time = d.getTime()
    res.send(time.toString());
});

//Add One Brick
app.get('/place', (req, res) => {
    bricks += 1;
    res.send("Success!<br>"+bricks.toString());
});