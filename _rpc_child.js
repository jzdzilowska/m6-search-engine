
const dist = require('@brown-ds/distribution')({ip:'127.0.0.1', port:7771});
dist.node.start(() => { process.send && process.send('ready'); });
