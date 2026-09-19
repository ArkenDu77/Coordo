import fs from 'fs';
import { Readable } from 'stream';

const FILE_SIZE = 300 * 1024 * 1024; // 300MB
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
const BASE_URL = 'http://localhost:3000';

async function runTest() {
  console.log('1. Generating 300MB dummy file...');
  if (!fs.existsSync('dummy.mp3')) {
    const buffer = Buffer.alloc(FILE_SIZE, 'a');
    fs.writeFileSync('dummy.mp3', buffer);
  }

  console.log('2. Initiating upload...');
  const form = new FormData();
  form.append('docx', new Blob(['dummy docx']), 'dummy.docx');
  form.append('subject', 'Test');
  form.append('courseName', 'Test Course');
  form.append('audioName', 'dummy.mp3');
  form.append('audioSize', FILE_SIZE.toString());
  form.append('audioMimeType', 'audio/mp3');

  const initRes = await fetch(`${BASE_URL}/api/upload/init`, {
    method: 'POST',
    body: form
  });
  
  if (!initRes.ok) {
    console.error('Init failed:', await initRes.text());
    process.exit(1);
  }
  
  const initData = await initRes.json();
  const jobId = initData.jobId;
  console.log(`Job ID: ${jobId}`);

  console.log('3. Uploading first 50% (simulating interruption)...');
  let offset = 0;
  const targetOffset = FILE_SIZE / 2;

  while (offset < targetOffset) {
    const end = Math.min(offset + CHUNK_SIZE, FILE_SIZE);
    const nodeStream = fs.createReadStream('dummy.mp3', { start: offset, end: end - 1 });
    const webStream = Readable.toWeb(nodeStream);
    const isLast = end >= FILE_SIZE;

    const chunkRes = await fetch(`${BASE_URL}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-job-id': jobId,
        'x-offset': offset.toString(),
        'x-is-last': isLast.toString(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': (end - offset).toString()
      },
      body: webStream,
      duplex: 'half'
    });

    if (!chunkRes.ok) {
        console.error(`Chunk failed: ${await chunkRes.text()}`);
        process.exit(1);
    }
    console.log(`Uploaded chunk offset ${offset} to ${end}`);
    offset = end;
  }

  console.log('4. Simulating interruption and resuming...');
  const statusRes = await fetch(`${BASE_URL}/api/upload/status?jobId=${jobId}`);
  const statusData = await statusRes.json();
  console.log('Status offset from Gemini API:', statusData.offset);

  offset = parseInt(statusData.offset, 10);
  console.log(`5. Resuming upload from offset ${offset} to completion...`);
  
  while (offset < FILE_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, FILE_SIZE);
    const nodeStream = fs.createReadStream('dummy.mp3', { start: offset, end: end - 1 });
    const webStream = Readable.toWeb(nodeStream);
    const isLast = end >= FILE_SIZE;

    const chunkRes = await fetch(`${BASE_URL}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-job-id': jobId,
        'x-offset': offset.toString(),
        'x-is-last': isLast.toString(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': (end - offset).toString()
      },
      body: webStream,
      duplex: 'half'
    });

    if (!chunkRes.ok) {
        console.error(`Chunk failed: ${await chunkRes.text()}`);
        process.exit(1);
    }
    console.log(`Uploaded chunk offset ${offset} to ${end}`);
    offset = end;
  }

  console.log('6. Checking final status in DB...');
  const jobRes = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
  const jobData = await jobRes.json();
  console.log(`Gemini FileName: ${jobData.geminiFileName}`);
  console.log(`Gemini File URI: ${jobData.geminiFileUri}`);
  
  console.log('Test completed successfully.');
}

runTest().catch(console.error);
