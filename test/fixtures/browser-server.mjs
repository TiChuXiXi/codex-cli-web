import { startFixture } from './start-app.mjs'
const app=await startFixture({port:18787})
let network
try {network=await startFixture({port:18788,persistedConfig:{authMode:'network',allowedClients:['127.0.0.1']}})}
catch(error) {await app.close();throw error}
const stop=async()=>{await Promise.all([app.close(),network.close()])}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
console.log('Fixture ready at '+app.origin+' and '+network.origin)
