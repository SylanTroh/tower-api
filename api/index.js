const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

const dataPath = 'numBricks.txt'

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

function SuccessResponse(res){
    const d = new Date();
    let time = d.getTime()
    res.send(
        bricks.toString()+"<br>"+
        time.toString()
    );
}

function FailureResponse(res){
    res.send("Error");
}

// Initialize Bricks
let bricks = fs.readFile(dataPath)
console.log(`Read Bricks from File: ` + bricks);

//Show Current Bricks and add One
app.get('/', (req, res) => {
    res.send(bricks.toString());
});
app.get('/bricks', (req, res) => {
    SuccessResponse(res);
});

//Add One Brick
app.get('/place/:id', (req, res) => {
    bricks += 1;
    fs.writeFile(dataPath,bricks.toString())
    console.log(`Placed Brick` + bricks + ` on ID: ` + req.params.id);
    SuccessResponse(res);
});