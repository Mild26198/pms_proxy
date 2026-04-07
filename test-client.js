/**
 * Test Client - Simulates Micros POS Server
 * Sends sample GI/GO/GC messages to test the listener
 * 
 * Usage: node test-client.js [host] [port]
 */

const net = require('net');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = parseInt(process.argv[3]) || 5016;

const STX = 0x02;
const ETX = 0x03;

function buildFrame(msg) {
  return Buffer.from([STX, ...Buffer.from(msg, 'ascii'), ETX]);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const client = new net.Socket();

client.connect(PORT, HOST, async () => {
  console.log(`✅ Connected to ${HOST}:${PORT}`);
  console.log('');

  const scenarios = [
    {
      label: '1. Link Start',
      msg: 'LS|DA260224|TI183000'
    },
    {
      label: '2. Guest Check-in - Diana (Room 117, Gold)',
      msg: 'GI|DA260224|TI183416|G#12402|RN117|GA260224|GD260225|GFDiana|GLEA|GNGold|GSN|GTMs'
    },
    {
      label: '3. Guest Check-in - Sharer (Room 117, Test)',
      msg: 'GI|DA260224|TI183418|G#12403|RN117|GA260224|GD260225|GFSharer|GLEA|GNTest|GSY'
    },
    {
      label: '4. Guest Change - Sharer room update',
      msg: 'GC|DA260224|TI183403|G#12403|GD260225|GFSharer|GLEA|GNTest|RN117|GSN'
    },
    {
      label: '5. Guest Check-out - Diana',
      msg: 'GO|DA260224|TI183403|G#12402|RN117|GSY'
    },
    {
      label: '6. Guest Check-out - Sharer',
      msg: 'GO|DA260224|TI183406|G#12403|RN117|GSN'
    },
    {
      label: '7. New Check-in - Diana re-checkin',
      msg: 'GI|DA260224|TI183500|G#12402|RN117|GA260224|GD260226|GFDiana|GLEA|GNGold|GSN|GTMs'
    }
  ];

  for (const scenario of scenarios) {
    console.log(`📤 Sending: ${scenario.label}`);
    console.log(`   Raw: ${scenario.msg}`);
    client.write(buildFrame(scenario.msg));
    await sleep(2000);
    console.log('');
  }

  // Send a few heartbeats
  for (let i = 0; i < 3; i++) {
    const now = new Date();
    const da = now.toISOString().slice(2, 10).replace(/-/g, '');
    const ti = now.toISOString().slice(11, 19).replace(/:/g, '');
    const msg = `LA|DA${da}|TI${ti}`;
    console.log(`💓 Heartbeat: ${msg}`);
    client.write(buildFrame(msg));
    await sleep(3000);
  }

  // Link End
  console.log('📤 Sending Link End');
  client.write(buildFrame('LE|DA260224|TI190000'));
  
  await sleep(1000);
  console.log('');
  console.log('✅ Test complete!');
  client.destroy();
});

client.on('data', (data) => {
  // Parse received frames
  let i = 0;
  while (i < data.length) {
    if (data[i] === STX) {
      const etxIdx = data.indexOf(ETX, i + 1);
      if (etxIdx !== -1) {
        const msg = data.subarray(i + 1, etxIdx).toString('ascii');
        console.log(`📥 Received: ${msg}`);
        i = etxIdx + 1;
      } else {
        break;
      }
    } else {
      i++;
    }
  }
});

client.on('close', () => {
  console.log('🔌 Connection closed');
  process.exit(0);
});

client.on('error', (err) => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
