import {ClientError} from './session.mjs';

// IUGG mean-radius sphere. A nautical mile is exactly 1852 metres.
const EARTH_RADIUS_KM=6371.0088;
const invalid=()=>new ClientError('TRACK_INPUT_INVALID','Supply at most 10000 timestamped WGS84 points and a positive finite maxGapSeconds');
function normalizePoint(p) {
  if(!p||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||p.latitude< -90||p.latitude>90||p.longitude< -180||p.longitude>180||typeof p.reportedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(p.reportedAt))throw invalid();
  const ms=Date.parse(p.reportedAt);
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,19)!==p.reportedAt.slice(0,19))throw invalid();
  return {ms,reportedAt:new Date(ms).toISOString(),latitude:p.latitude,longitude:p.longitude};
}
function distance(a,b) {
  const rad=Math.PI/180,lat1=a.latitude*rad,lat2=b.latitude*rad;
  const dlat=lat2-lat1,dlon=(((b.longitude-a.longitude)+540)%360-180)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;
  const clamped=Math.max(0,Math.min(1,h));
  const km=2*EARTH_RADIUS_KM*Math.atan2(Math.sqrt(clamped),Math.sqrt(1-clamped));
  return {distanceKm:km,distanceNm:km/1.852};
}

/**
 * Pure measurements over caller-supplied history. No live lookup, inferred fixes
 * or interpolation. Conflicting fixes at an instant invalidate both adjacent
 * intervals; filtering them out and joining their neighbours would hide a gap.
 */
export function measureTrack(points,options={}) {
  const maxGapSeconds=options?.maxGapSeconds??3600;
  if(!Array.isArray(points)||points.length>10000||!Number.isFinite(maxGapSeconds)||maxGapSeconds<=0)throw invalid();
  const sorted=points.map(normalizePoint).sort((a,b)=>a.ms-b.ms);
  const groups=[];let duplicateRecordsRemoved=0;
  for(const p of sorted) {
    let group=groups.at(-1);
    if(!group||group.ms!==p.ms){group={ms:p.ms,reportedAt:p.reportedAt,positions:new Map()};groups.push(group);}
    const key=p.latitude+','+p.longitude;
    if(group.positions.has(key))duplicateRecordsRemoved++;
    else group.positions.set(key,p);
  }
  const conflictingTimestamps=groups.filter(g=>g.positions.size>1).map(g=>({reportedAt:g.reportedAt,distinctPositions:g.positions.size}));
  const usablePointCount=groups.filter(g=>g.positions.size===1).length;
  const segments=[],gaps=[];
  let observedDistanceKm=0,observedSegmentSeconds=0,excludedIntervalSeconds=0,largestReportedIntervalSeconds=0;
  for(let i=1;i<groups.length;i++) {
    const before=groups[i-1],after=groups[i],elapsedSeconds=(after.ms-before.ms)/1000;
    // Grouping ensures a strictly positive interval, including fractional seconds.
    if(elapsedSeconds<=0)throw invalid();
    largestReportedIntervalSeconds=Math.max(largestReportedIntervalSeconds,elapsedSeconds);
    const interval={fromReportedAt:before.reportedAt,toReportedAt:after.reportedAt,elapsedSeconds};
    const conflict=before.positions.size!==1||after.positions.size!==1;
    const exceedsMaxGap=elapsedSeconds>maxGapSeconds;
    if(conflict||exceedsMaxGap) {
      const gap={...interval,reason:conflict?'timestamp_conflict':'time_gap',exceedsMaxGap};
      if(!conflict) {
        const d=distance(before.positions.values().next().value,after.positions.values().next().value);
        Object.assign(gap,{endpointSeparationKm:d.distanceKm,endpointSeparationNm:d.distanceNm,endpointSeparationIsObservedRoute:false});
      }
      gaps.push(gap);excludedIntervalSeconds+=elapsedSeconds;continue;
    }
    const d=distance(before.positions.values().next().value,after.positions.values().next().value);
    segments.push({...interval,...d,derivedGroundSpeedKnots:d.distanceNm/(elapsedSeconds/3600)});
    observedDistanceKm+=d.distanceKm;observedSegmentSeconds+=elapsedSeconds;
  }
  const elapsedSeconds=groups.length>1?(groups.at(-1).ms-groups[0].ms)/1000:0;
  const observedDistanceNm=observedDistanceKm/1.852;
  const averageObservedSegmentSpeedKnots=observedSegmentSeconds>0?observedDistanceNm/(observedSegmentSeconds/3600):null;
  return {
    status:segments.length?'measured':'insufficient_connected_points',
    inputPointCount:points.length,uniqueRecordCount:points.length-duplicateRecordsRemoved,
    duplicateRecordsRemoved,usablePointCount,conflictingTimestamps,
    firstReportedAt:groups[0]?.reportedAt??null,lastReportedAt:groups.at(-1)?.reportedAt??null,
    elapsedSeconds,maxGapSeconds,largestReportedIntervalSeconds,
    observedSegmentSeconds,excludedIntervalSeconds,observedDistanceKm,observedDistanceNm,
    averageObservedSegmentSpeedKnots,
    observedDistanceOverWallTimeKnots:segments.length&&elapsedSeconds>0?observedDistanceNm/(elapsedSeconds/3600):null,
    maximumDerivedGroundSpeedKnots:segments.length?Math.max(...segments.map(s=>s.derivedGroundSpeedKnots)):null,
    segmentCount:segments.length,gapCount:gaps.length,segments,gaps,
    earthModel:{shape:'mean-radius sphere',radiusKm:EARTH_RADIUS_KM,nauticalMileMetres:1852},
    actualRouteDistanceKnown:false,
    distanceMeaning:'Sum of shortest spherical endpoint separations for accepted consecutive fixes; a route-distance lower bound assuming accurate positions. Long gaps and timestamp conflicts are excluded.',
    observedAverageMeaning:'Distance divided by the summed duration of accepted segments, weighted by segment duration; derived from positions rather than reported instrument speed.',
    wallTimeRatioMeaning:'Accepted-segment distance divided by the entire supplied time span, including excluded intervals. This is not the actual average travel speed during missing coverage.',
    historyRetentionKnown:false,
    coverage:'Only supplied records are measured. Source retention, completeness, missing route, actual current location and positioning accuracy are not established.'
  };
}
