import {readFileSync} from 'node:fs';
import {ClientError} from './session.mjs';

// Normalized exclusively from the supplied APK res/raw/airports.json and
// countries.json. Country membership is a source ID join, not inferred borders.
const catalog=JSON.parse(readFileSync(new URL('./airport-catalog.json',import.meta.url),'utf8'));
const countries=new Map(catalog.countries.map(c=>[c.id,c]));
const timezones=new Map();
for(const row of catalog.airports)if(!timezones.has(row.timezone)){
  try{new Intl.DateTimeFormat('en',{timeZone:row.timezone});timezones.set(row.timezone,true);}
  catch{timezones.set(row.timezone,false);}
}
const rows=catalog.airports.map(row=>{
  const country=countries.get(row.countryId);
  return {id:row.id,name:row.name,iata:row.iata,icao:row.icao,city:row.city,latitude:row.lat,longitude:row.lon,
    country:{id:country.id,name:country.name,fullName:country.fullName,alpha2:country.alpha2,alpha3:country.alpha3},
    timezone:row.timezone,timezoneValid:timezones.get(row.timezone)===true};
});
const codeIndex=new Map();
for(const row of rows)for(const code of [String(row.id),row.iata,row.icao])if(code){
  const values=codeIndex.get(code.toUpperCase())??[];
  if(!values.some(value=>value.id===row.id))values.push(row);
  codeIndex.set(code.toUpperCase(),values);
}
const normalize=value=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
function invalid(message){return new ClientError('REGION_INVALID',message);}
function airportByCode(code){
  if(typeof code==='number'&&Number.isInteger(code))code=String(code);
  if(typeof code!=='string'||!/^[A-Za-z0-9]{1,12}$/.test(code.trim()))throw new ClientError('AIRPORT_INVALID','Provide an airport IATA, ICAO or numeric catalog ID');
  const found=codeIndex.get(code.trim().toUpperCase())??[];
  if(!found.length)throw new ClientError('AIRPORT_NOT_FOUND','Airport code is absent from the supplied catalog');
  if(found.length!==1)throw new ClientError('AIRPORT_AMBIGUOUS','Airport code matches multiple catalog entries');
  return found[0];
}

/** Exact IATA/ICAO/numeric-ID lookup; no fuzzy name or geographic inference. */
export function resolveAirport(code){return structuredClone(airportByCode(code));}

function bboxPredicate(bbox){
  if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))throw invalid('bbox must be [west,south,east,north] in degrees');
  const [west,south,east,north]=bbox;
  if(west < -180||west > 180||east < -180||east > 180||south < -90||north > 90||south>=north||west===east)throw invalid('Invalid bbox coordinate range or zero-area bounds');
  return row=>row.latitude>=south&&row.latitude<=north&&(west<east?(row.longitude>=west&&row.longitude<=east):(row.longitude>=west||row.longitude<=east));
}
const EPS=1e-10;
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function onSegment(point,a,b){
  return Math.abs(cross(a,b,point))<=EPS&&point[0]>=Math.min(a[0],b[0])-EPS&&point[0]<=Math.max(a[0],b[0])+EPS&&point[1]>=Math.min(a[1],b[1])-EPS&&point[1]<=Math.max(a[1],b[1])+EPS;
}
function intersects(a,b,c,d){
  const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
  return (x*y < 0&&z*w < 0)||onSegment(c,a,b)||onSegment(d,a,b)||onSegment(a,c,d)||onSegment(b,c,d);
}
function inRing(point,ring){
  let inside=false;
  for(let i=0;i<ring.length-1;i++){
    const a=ring[i],b=ring[i+1];if(onSegment(point,a,b))return true;
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function validateRing(ring){
  if(!Array.isArray(ring)||ring.length<4||ring.length>2000||ring.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<-180||p[0]>180||p[1]<-90||p[1]>90))throw invalid('Polygon rings need 4 to 2000 valid [longitude,latitude] coordinates');
  if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw invalid('Polygon rings must be explicitly closed');
  // RFC7946 section3.1.1: edges are straight Cartesian lines between positions.
  // Preserve wide polygons; antimeridian-wrapping selection is explicit in bbox.
  const result=ring.map(([lon,lat])=>[lon,lat]);
  const area=result.slice(0,-1).reduce((sum,p,i)=>sum+p[0]*result[i+1][1]-result[i+1][0]*p[1],0);
  if(Math.abs(area)<=EPS)throw invalid('Polygon ring has zero area');
  for(let i=0;i<result.length-1;i++){
    if(result[i][0]===result[i+1][0]&&result[i][1]===result[i+1][1])throw invalid('Polygon ring contains a duplicate adjacent vertex');
    for(let j=i+2;j<result.length-1;j++){
      if(i===0&&j===result.length-2)continue;
      if(intersects(result[i],result[i+1],result[j],result[j+1]))throw invalid('Self-intersecting polygon rings are unsupported');
    }
  }
  return result;
}
function ringsIntersect(a,b){
  for(let i=0;i<a.length-1;i++)for(let j=0;j<b.length-1;j++)if(intersects(a[i],a[i+1],b[j],b[j+1]))return true;
  return false;
}
function polygonPredicate(polygon){
  if(!polygon||polygon.type!=='Polygon'||!Array.isArray(polygon.coordinates)||!polygon.coordinates.length||polygon.coordinates.length>20)throw invalid('polygon must be a GeoJSON Polygon with one outer ring and optional holes');
  if(polygon.coordinates.reduce((n,r)=>n+(Array.isArray(r)?r.length:10001),0)>10000)throw invalid('Polygon exceeds the 10000-vertex bound');
  const rings=polygon.coordinates.map(validateRing);
  for(let i=1;i<rings.length;i++){
    if(!inRing(rings[i][0],rings[0])||ringsIntersect(rings[i],rings[0]))throw invalid('Polygon holes must be strictly inside the outer ring');
    for(let j=1;j<i;j++)if(ringsIntersect(rings[i],rings[j])||inRing(rings[i][0],rings[j])||inRing(rings[j][0],rings[i]))throw invalid('Polygon holes must not overlap or contain each other');
  }
  return row=>{
    const point=[row.longitude,row.latitude];
    return inRing(point,rings[0])&&!rings.slice(1).some(ring=>inRing(point,ring));
  };
}

/** Choose destination airports by one source-backed country, geometry or code set. */
export function resolveAirports(selection){
  if(!selection||typeof selection!=='object'||Array.isArray(selection))throw invalid('Provide one airport region selector');
  const allowed=['country','bbox','polygon','airports'];
  if(Object.keys(selection).some(k=>!allowed.includes(k)))throw invalid('Unknown airport region selection field');
  const modes=allowed.filter(key=>selection[key]!==undefined);
  if(modes.length!==1)throw invalid('Use exactly one selector: country, bbox, polygon or explicit airports');
  const mode=modes[0];let selected,description;
  if(mode==='country'){
    if(typeof selection.country!=='string'||!selection.country.trim()||selection.country.length>160)throw invalid('Provide a source country name or ISO code');
    const key=normalize(selection.country),found=catalog.countries.filter(c=>[c.alpha2,c.alpha3,c.name,c.fullName].some(name=>normalize(name)===key));
    if(found.length!==1)throw new ClientError('COUNTRY_NOT_FOUND','Country is unknown or ambiguous in the supplied country catalog');
    const country=found[0];selected=rows.filter(row=>row.country.id===country.id);description={mode,country:{id:country.id,name:country.name,alpha2:country.alpha2,alpha3:country.alpha3}};
  }else if(mode==='airports'){
    if(!Array.isArray(selection.airports)||!selection.airports.length||selection.airports.length>10000)throw invalid('Explicit airports must contain 1 to 10000 IATA, ICAO or numeric IDs');
    selected=[...new Map(selection.airports.map(airportByCode).map(row=>[row.id,row])).values()];description={mode,requested:selection.airports.length};
  }else{
    const predicate=mode==='bbox'?bboxPredicate(selection.bbox):polygonPredicate(selection.polygon);
    selected=rows.filter(predicate);description={mode,[mode]:structuredClone(selection[mode])};
  }
  return structuredClone({source:catalog.source,scope:'airport_destinations',selection:description,count:selected.length,airports:selected,
    catalog:{airportCount:rows.length,countryCount:catalog.countries.length,airportTimestamp:catalog.airportCatalogTimestamp,airportUpdatedAt:catalog.airportCatalogUpdatedAt,countryTimestamp:catalog.countryCatalogTimestamp,countryUpdatedAt:catalog.countryCatalogUpdatedAt,airportSource:catalog.airportSource,airportSourceSha256:catalog.airportSourceSha256,countrySource:catalog.countrySource,countrySourceSha256:catalog.countrySourceSha256},
    coverage:{allSelectedCatalogAirportsIncluded:true,completeWorldwideAirportCensus:false,overflightsIncluded:false,airspaceBoundary:false},
    message:'Airport destination selection from the dated supplied catalog. This does not define national airspace, count overflights or establish flight/cargo coverage. Use the named IANA timezone for historical dates, not a fixed catalog UTC offset.'});
}
