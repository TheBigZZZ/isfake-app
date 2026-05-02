#!/usr/bin/env node
import { performance } from 'perf_hooks';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const REQUESTS = Number(process.env.REQUESTS || 50);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);

function stats(arr) {
  arr.sort((a,b)=>a-b);
  const sum = arr.reduce((s,x)=>s+x,0);
  const avg = sum/arr.length;
  const p95 = arr[Math.floor(arr.length*0.95)-1] || arr[arr.length-1];
  const p99 = arr[Math.floor(arr.length*0.99)-1] || arr[arr.length-1];
  return { count: arr.length, avg, min: arr[0], max: arr[arr.length-1], p95, p99 };
}

async function hit(url, options){
  const t0 = performance.now();
  try{
    const r = await fetch(url, options);
    const text = await (r.headers.get('content-type') || '').includes('json') ? r.json().catch(()=>null) : r.text().catch(()=>null);
    const t1 = performance.now();
    return { ok: r.ok, status: r.status, dur: t1-t0 };
  }catch(e){
    const t1 = performance.now();
    return { ok:false, status:0, dur: t1-t0, error: e.message };
  }
}

async function runSeries(path, count){
  const latencies = [];
  for(let i=0;i<count;i++){
    const res = await hit(`${BASE_URL}${path}`, { method: 'GET' });
    latencies.push(res.dur);
  }
  return stats(latencies);
}

async function runConcurrent(path, total, concurrency, method='POST', body=null){
  const latencies = [];
  let inFlight = 0;
  let started = 0;

  return new Promise((resolve)=>{
    function launch(){
      while(inFlight < concurrency && started < total){
        inFlight++; started++;
        (async ()=>{
          const opts = { method, headers: {'Content-Type':'application/json'} };
          if(body) opts.body = JSON.stringify(body);
          const res = await hit(`${BASE_URL}${path}`, opts);
          latencies.push(res.dur);
          inFlight--;
          if(latencies.length === total) resolve(stats(latencies));
          else launch();
        })();
      }
    }
    launch();
  });
}

(async ()=>{
  console.log('Base URL:', BASE_URL);
  console.log(`Running baseline /api/health (${REQUESTS} requests sequential)`);
  const h = await runSeries('/api/health', REQUESTS);
  console.log('Health stats:', h);

  console.log(`\nRunning /api/scan concurrent test: total=${REQUESTS} concurrency=${CONCURRENCY}`);
  // minimal scan payload (may return 401 if auth required)
  const payload = { barcode: '0000000000', image_base64: '', ocr_text: '' };
  const s = await runConcurrent('/api/scan', REQUESTS, CONCURRENCY, 'POST', payload);
  console.log('Scan stats:', s);

  process.exit(0);
})();
