import test from 'node:test';
import assert from 'node:assert/strict';
const {analyzeHistoryRecords}=await import('../history-analysis.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const airports=[{id:1,country:{alpha2:'AA'}},{id:2,country:{alpha2:'BB'}}];
const resolvers={resolveAirports:()=>({airports:[airports[0]],catalog:{dated:true}}),resolveAirport:id=>{const row=airports.find(a=>a.id===id);if(!row)throw Error('private resolver detail');return row;}};
const row=(x={})=>({flightId:'abc1',eventTime:'2026-10-01T12:00:00Z',eventType:'landed',eventAirportId:9,aircraftType:'B744',registration:'N-EXAMPLE',originId:1,airlineId:10,...x});
const job={jobId:'fixture-job',status:'waiting',updatedAt:'2026-10-02T12:00:00Z',progress:{completedRequestCount:1},secret:'never-return'};

test('analysis deduplicates event identity including airport, keeps flight/event/airframe counts distinct and does no fetch',()=>{
  assert.equal(typeof analyzeHistoryRecords,'function');
  const records=[row(),row(),row({eventAirportId:8}),row({flightId:'abc2',eventTime:'2026-10-01T13:00:00Z'})];
  const before=JSON.stringify(records),old=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden');};
  try{const result=analyzeHistoryRecords({records,job},resolvers);
    assert.equal(result.inputRecordCount,4);assert.equal(result.duplicateEventsRemoved,1);assert.equal(result.observedMatchingEvents,3);
    assert.equal(result.distinctKnownFlightIds,2);assert.equal(result.uniqueObservedRegistrations,1);
    assert.equal(result.snapshot.updatedAt,job.updatedAt);assert.equal(result.snapshot.secret,undefined);
    assert.equal(result.reportedTimeRange.first,'2026-10-01T12:00:00.000Z');assert.equal(result.complete,false);assert.equal(result.exactCargoArrivalCount,null);
    assert.equal(result.records,undefined);assert.equal(JSON.stringify(records),before);
  }finally{globalThis.fetch=old;}
});

test('outside origins exclude null and unresolved catalog IDs; exact type filter has explicit counter scopes',()=>{
  const records=[row(),row({flightId:'b',originId:2}),row({flightId:'c',originId:null}),row({flightId:'d',originId:999}),row({flightId:'e',aircraftType:null}),row({flightId:'f',aircraftType:'B738',originId:2})];
  const result=analyzeHistoryRecords({records,aircraftTypes:['B744'],originFilter:{selection:{country:'AA'},mode:'outside'}},resolvers);
  assert.equal(result.observedMatchingEvents,1);assert.equal(result.unknownTypeCount,1);assert.equal(result.unknownOriginCount,2);
  assert.deepEqual(result.originCounts,{inside:1,outside:1,unknown:2});assert.equal(result.groups[0].key,'B744');
  const inside=analyzeHistoryRecords({records,aircraftTypes:['B744'],originFilter:{selection:{country:'AA'},mode:'inside'}},resolvers);
  assert.equal(inside.observedMatchingEvents,1);
});

test('bounded groups sort by count and report omitted groups without leaking records',()=>{
  const records=[row(),row({flightId:'b',aircraftType:'B738'}),row({flightId:'c',aircraftType:'B738'}),row({flightId:'d',aircraftType:null})];
  const result=analyzeHistoryRecords({records,maxGroups:1},resolvers);
  assert.equal(result.groups.length,1);assert.equal(result.groups[0].key,'B738');assert.equal(result.groups[0].observedMatchingEvents,2);
  assert.equal(result.groupCount,3);assert.equal(result.omittedGroupCount,2);
  const byCountry=analyzeHistoryRecords({records:[row(),row({flightId:'b',originId:2}),row({flightId:'c',originId:null})],groupBy:'originCountry'},resolvers);
  assert.deepEqual(new Set(byCountry.groups.map(g=>g.key)),new Set(['AA','BB',null]));
  const airline=analyzeHistoryRecords({records:[row(),row({flightId:'b',airlineId:null})],groupBy:'airlineId'},resolvers);
  assert.deepEqual(new Set(airline.groups.map(g=>g.key)),new Set([10,null]));
});

test('immutable empty or partial snapshots remain incomplete and preserve source time meaning',()=>{
  const frozen=Object.freeze([Object.freeze(row())]);Object.freeze(job.progress);Object.freeze(job);
  const result=analyzeHistoryRecords({records:frozen,job},resolvers);assert.equal(result.observedMatchingEvents,1);
  assert.equal(result.cargoClassificationAvailable,false);
  const empty=analyzeHistoryRecords({records:[],job},resolvers);assert.equal(empty.observedMatchingEvents,0);assert.equal(empty.reportedTimeRange.first,null);assert.equal(empty.complete,false);
});

test('invalid filters, oversized inputs and invalid events fail with sanitized errors',()=>{
  for(const args of [{records:[],maxGroups:0},{records:[],maxGroups:51},{records:[],aircraftTypes:[]},{records:[],aircraftTypes:Array(101).fill('B744')},{records:[],aircraftTypes:['*']},{records:[],groupBy:'secret'},{records:[],originFilter:{selection:{country:'AA'},mode:'other'}},{records:Array(100001).fill(row())},{records:[row({eventTime:'invalid'})]},{records:[],secret:'private'}]){
    assert.throws(()=>analyzeHistoryRecords(args,resolvers),e=>e.code==='HISTORY_ANALYSIS_INPUT_INVALID'&&!e.message.includes('private'));
  }
  assert.throws(()=>analyzeHistoryRecords({records:[],originFilter:{selection:{country:'X'},mode:'outside'}},{...resolvers,resolveAirports:()=>{throw Error('private value');}}),e=>e.code==='HISTORY_ANALYSIS_INPUT_INVALID'&&!e.message.includes('private'));
});
