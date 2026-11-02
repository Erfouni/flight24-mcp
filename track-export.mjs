import {ClientError} from './session.mjs';

const MAX_BYTES=4*1024*1024;
const invalid=()=>new ClientError('TRACK_EXPORT_INPUT_INVALID','Provide up to 10000 valid timestamped WGS84 points, csv or kml format, a name of up to 120 characters and a positive maxGapSeconds');
function normalize(point){
  if(!point||typeof point!=='object'||!Number.isFinite(point.latitude)||Math.abs(point.latitude)>90||!Number.isFinite(point.longitude)||Math.abs(point.longitude)>180||typeof point.reportedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(point.reportedAt))throw invalid();
  const ms=Date.parse(point.reportedAt);
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,19)!==point.reportedAt.slice(0,19))throw invalid();
  for(const key of ['altitudeFeet','speedKnots'])if(point[key]!=null&&(!Number.isFinite(point[key])||(key==='speedKnots'&&point[key]<0)))throw invalid();
  return {ms,reportedAt:new Date(ms).toISOString(),latitude:point.latitude,longitude:point.longitude,altitudeFeet:point.altitudeFeet??null,speedKnots:point.speedKnots??null};
}
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
// Only validated ISO timestamps, finite numbers and fixed headers reach CSV.
// The prefix also protects future textual columns from spreadsheet formulas.
const csv=value=>{let text=value==null?'':String(value);if(typeof value==='string'&&/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
function kml(segments,name){
  // Official gx:Track requires three coord values. Ground projection explicitly
  // ignores the zero altitude; original altitude is retained separately below.
  // https://developers.google.com/kml/documentation/kmlreference#gxtrack
  const schema='<Schema id="samples"><gx:SimpleArrayField name="altitudeFeet" type="string"><displayName>Reported altitude feet; datum unspecified</displayName></gx:SimpleArrayField><gx:SimpleArrayField name="speedKnots" type="string"><displayName>Reported speed knots</displayName></gx:SimpleArrayField></Schema>';
  const tracks=segments.map((points,index)=>{
    const when=points.map(p=>'<when>'+p.reportedAt+'</when>').join('');
    const coords=points.map(p=>'<gx:coord>'+p.longitude+' '+p.latitude+' 0</gx:coord>').join('');
    // A literal unknown avoids gx:Track's interpolation of empty array values.
    const data=['altitudeFeet','speedKnots'].map(key=>'<gx:SimpleArrayData name="'+key+'">'+points.map(p=>'<gx:value>'+xml(p[key]??'unknown')+'</gx:value>').join('')+'</gx:SimpleArrayData>').join('');
    return '<Placemark><name>Segment '+(index+1)+'</name><gx:Track><altitudeMode>clampToGround</altitudeMode>'+when+coords+'<ExtendedData><SchemaData schemaUrl="#samples">'+data+'</SchemaData></ExtendedData></gx:Track></Placemark>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>'+xml(name)+'</name><description>Supplied observations only. Completeness and actual route are unknown. Separate segments do not bridge missing coverage, timestamp conflicts or antimeridian crossings. Display is projected onto ground; reported altitude is metadata, not measured ground elevation.</description>'+schema+tracks+'</Document></kml>';
}

/** Pure export; no upstream download, interpolation, sample removal or file writes. */
export function exportTrack(points,options={}){
  if(!Array.isArray(points)||points.length>10000||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['format','name','maxGapSeconds'].includes(key)))throw invalid();
  const {format,name='track',maxGapSeconds=3600}=options;
  if(!['csv','kml'].includes(format)||typeof name!=='string'||!name.trim()||name.length>120||!name.isWellFormed()||/[\u0000-\u001f\u007f\ufffe\uffff]/u.test(name)||!Number.isFinite(maxGapSeconds)||maxGapSeconds<=0)throw invalid();
  const sorted=Array.from(points,normalize).sort((a,b)=>a.ms-b.ms);
  const positionsByTime=new Map();
  for(const point of sorted){const positions=positionsByTime.get(point.ms)??new Set();positions.add(point.latitude+','+point.longitude);positionsByTime.set(point.ms,positions);}
  const segments=[],breaks={timeGap:0,antimeridian:0,timestampConflict:0};
  for(const point of sorted){
    const previous=segments.at(-1)?.at(-1);
    const timeGap=previous&&(point.ms-previous.ms)/1000>maxGapSeconds;
    const antimeridian=previous&&Math.abs(point.longitude-previous.longitude)>180;
    const timestampConflict=previous&&(positionsByTime.get(point.ms).size>1||positionsByTime.get(previous.ms).size>1);
    if(timeGap)breaks.timeGap++;if(antimeridian)breaks.antimeridian++;if(timestampConflict)breaks.timestampConflict++;
    if(!previous||timeGap||antimeridian||timestampConflict)segments.push([]);
    segments.at(-1).push(point);
  }
  const columns=['reportedAt','latitude','longitude','altitudeFeet','speedKnots'];
  const text=format==='csv'?[columns.map(csv).join(','),...sorted.map(point=>columns.map(key=>csv(point[key])).join(','))].join('\r\n')+'\r\n':kml(segments,name);
  if(Buffer.byteLength(text,'utf8')>MAX_BYTES)throw new ClientError('TRACK_EXPORT_TOO_LARGE','Track export exceeds the 4 MiB text limit');
  const stem=name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^[-_]+|[-_]+$/g,'').slice(0,80)||'track';
  return {filename:stem+'.'+format,mimeType:format==='csv'?'text/csv':'application/vnd.google-earth.kml+xml',text,pointCount:sorted.length,
    coverage:{complete:false,suppliedPointCount:points.length,exportedPointCount:sorted.length,invalidPointsDropped:0,duplicatesRemoved:0,interpolatedPointCount:0,
      firstReportedAt:sorted[0]?.reportedAt??null,lastReportedAt:sorted.at(-1)?.reportedAt??null,maxGapSeconds,segmentCount:segments.length,breaks,
      altitudeRendering:format==='kml'?'ground_projection_not_measured_elevation':'reported_feet_unmodified',
      actualRouteKnown:false,historyRetentionKnown:false,reason:'All valid supplied samples are preserved in chronological order, including duplicates. Source retention, historical completeness and actual movement between samples are not established. KML segments separate gaps, timestamp conflicts and antimeridian crossings; CSV contains observations only.'}};
}
