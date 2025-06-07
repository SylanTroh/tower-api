const express = require('express');
const app = express();

const port = process.env.PORT || 3000; // Use the port provided by the host or default to 3000
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
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