# Data-only geographic preprocessing. Not game implementation.
from pathlib import Path
import json,hashlib,math,csv
import numpy as np
import rasterio
from rasterio.warp import reproject,Resampling
from rasterio.transform import from_origin
from pyproj import Transformer
P=Path('/workspace/slop-glens-falls/research/cc005b-topography')
D=Path('/workspace/slop-glens-falls/lidar/tiles')
paths=[D/'USGS_1M_18_x60y480_NY_Hudson_D22.tif',D/'USGS_1M_18_x61y480_NY_Hudson_D22.tif']
bounds=[606980,4793840,612800,4798420];W=bounds[2]-bounds[0];H=bounds[3]-bounds[1]
t1=from_origin(bounds[0],bounds[3],1,1);a=np.full((H,W),-999999,dtype=np.float32)
sources=[]
for p in paths:
 with rasterio.open(p) as ds:
  # Reproject to aligned reference lattice, with <0.00004m lattice shift from encoded TIFFs.
  reproject(rasterio.band(ds,1),a,src_transform=ds.transform,src_crs=ds.crs,dst_transform=t1,dst_crs=ds.crs,src_nodata=ds.nodata,dst_nodata=-999999,resampling=Resampling.nearest,init_dest_nodata=False)
  sources.append({'name':p.name,'url':'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/NY_Hudson_D22/TIFF/'+p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'bounds':list(ds.bounds),'crs':str(ds.crs),'transform':list(ds.transform),'nodata':ds.nodata,'pixelM':list(ds.res)})
valid=a!=-999999
assert valid.all(),'Unexpected nodata: do not fill'
# Deterministic candidate 2m lattice: mean of four source samples. Preserve 1m original hill crop separately.
b=a.reshape(H//2,2,W//2,2).mean(axis=(1,3),dtype=np.float64).astype(np.float32)
t2=from_origin(bounds[0],bounds[3],2,2)
prof={'driver':'GTiff','height':H//2,'width':W//2,'count':1,'dtype':'float32','crs':'EPSG:26918','transform':t2,'nodata':-999999,'compress':'deflate','predictor':3,'tiled':True}
out=P/'gf-dem-candidate-2m.tif'
with rasterio.open(out,'w',**prof) as ds:ds.write(b,1)
# reconstruct candidate at every 1m reference pixel with bilinear, all cells incl padded bounds.
r=np.full_like(a,-999999)
reproject(b,r,src_transform=t2,src_crs='EPSG:26918',dst_transform=t1,dst_crs='EPSG:26918',src_nodata=-999999,dst_nodata=-999999,resampling=Resampling.bilinear)
T=Transformer.from_crs(26918,4326,always_xy=True);TT=Transformer.from_crs(4326,26918,always_xy=True)
# process rows in chunks to bound memory and identify exact WGS84 target mask.
errors=[];maxes=[];audit=[];count=0;refmin=1e9;refmax=-1e9
for start in range(0,H,100):
 yy=bounds[3]-np.arange(start,min(start+100,H))[:,None]-.5;xx=bounds[0]+np.arange(W)[None,:]+.5
 x,y=np.broadcast_arrays(xx,yy);lon,lat=T.transform(x,y)
 mask=(lon>=-73.68)&(lon<=-73.61)&(lat>=43.29)&(lat<=43.33)
 er=np.abs(r[start:start+len(yy)]-a[start:start+len(yy)])
 errors.append(er[mask]);count+=mask.sum();vals=a[start:start+len(yy)][mask];refmin=min(refmin,float(vals.min()));refmax=max(refmax,float(vals.max()))
 ind=np.unravel_index(np.argmax(np.where(mask,er,-1)),er.shape);rr=start+ind[0];cc=ind[1]
 maxes.append({'row':int(rr),'col':int(cc),'lon':float(lon[ind]),'lat':float(lat[ind]),'referenceM':float(a[rr,cc]),'candidateM':float(r[rr,cc]),'absErrorM':float(er[ind])})
 # Fixed sparse audit lattice, with exact original reference values.
 for row in range(start,min(start+100,H)):
  if row%50:continue
  for col in range(0,W,50):
   if mask[row-start,col]:audit.append([row,col,float(a[row,col]),float(r[row,col])])
e=np.concatenate(errors);worst=sorted(maxes,key=lambda x:x['absErrorM'],reverse=True)[:20]
anchor={'source':'OSM roads snapshot from gf-osm-data.zip','osmNode':221400851,'sourceUrl':'https://www.openstreetmap.org/node/221400851','description':'shared Glen Street / Bay Street / South Street node; a sourced geographic reference, not surveyed road-deck height','lon':-73.6464714,'lat':43.3108659}
x,y=TT.transform(anchor['lon'],anchor['lat'])
# bilinear sample on 1m reference centers
col=x-bounds[0]-.5;row=bounds[3]-y-.5;i=int(np.floor(row));j=int(np.floor(col));fx=col-j;fy=row-i
anchor['utmE']=x;anchor['utmN']=y;anchor['demNAVD88M']=float((1-fx)*(1-fy)*a[i,j]+fx*(1-fy)*a[i,j+1]+(1-fx)*fy*a[i+1,j]+fx*fy*a[i+1,j+1]);anchor['proposedGameYAtAnchor']=0;anchor['verticalRule']='For unmodified terrain: gameY = DEM_NAVD88_m - anchor.demNAVD88M; Claude must reconcile actual current coordinate frame and road/bridge deck without silently moving xz geography.'
report={'targetWgs84Bounds':{'west':-73.68,'south':43.29,'east':-73.61,'north':43.33},'targetBasis':'existing raw OSM README bbox and delivered tree JSON meta.bbox, not a guessed runtime extent; Claude verifies current main uses same play area','paddedProjectedBounds':bounds,'sourceCRS':'EPSG:26918 as encoded','verticalDatum':'NAVD88 GEOID18 metres per USGS/NOAA dataset metadata; horizontal metadata describes NAD83(2011), TIFF encodes EPSG:26918: preserve/report this distinction; no survey-grade reprojection claim','sourceInputs':sources,'candidate':{'file':out.name,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'bytes':out.stat().st_size,'shape':[H//2,W//2],'resolutionM':2,'dtype':'float32','transform':list(t2),'method':'1m source samples aligned to integer-metre UTM reference using nearest (<0.00004m lattice shift), then mean of each 2x2 block, stored float32; runtime reconstruction evaluated bilinear','notFinalRuntimeDesign':True},'coverage':{'referencePixelsInExactTarget':int(count),'missingReferencePixelsInExactTarget':0,'missingPixelsInPaddedProjectedRectangle':int((~valid).sum()),'edgeStripsMissing':False,'note':'all 1m reference cells in padded rectangle valid, dense projected boundary inside two source extents; no extra DEM acquisition needed for established bbox','minReferenceM':refmin,'maxReferenceM':refmax},'candidateErrorVs1m':{'method':'bilinear reconstruct 2m candidate at every 1m reference pixel centre inside exact WGS84 bbox, absolute elevation difference; whole terrain incl banks/water is retained in audit','n':int(len(e)),'maeM':float(np.mean(e)),'rmseM':float(np.sqrt(np.mean(e**2))),'p50M':float(np.percentile(e,50)),'p95M':float(np.percentile(e,95)),'p99M':float(np.percentile(e,99)),'maxM':float(e.max()),'countAbove0_25M':int((e>.25).sum()),'countAbove0_5M':int((e>.5).sum()),'countAbove1M':int((e>1).sum()),'worstLocations':worst},'anchor':anchor,'license':'USGS public-domain government work; credit USGS 3D Elevation Program','datasetUrl':'https://www.fisheries.noaa.gov/inport/item/73809','pointCloudNpzCaveat':'dt_d22.npz is NOT a terrain grid. Arrays x,y,z,c,r,n,g; 4,562,339 mixed-class point records, x/y numerical range consistent with Web Mercator EPT but no embedded CRS/units metadata; do not use as an authoritative ground grid. Ground filtering/provenance would be necessary. 1m GeoTIFFs are used instead.'}
(P/'terrain-provenance-and-validation.json').write_text(json.dumps(report,indent=2)+'\n')
with open(P/'reference-audit-lattice.csv','w') as f:
 w=csv.writer(f);w.writerow(['referenceRow','referenceCol','source1mNAVD88m','candidateReconstructedNAVD88m']);w.writerows(audit)
# Native-resolution audit/refinement patches wherever 2m reconstruction differs >0.25m.
# Whole 64m blocks with an 8m halo preserve original values for local refinement;
# these are input DATA, not a claimed final runtime patch-merging implementation.
patch=np.full_like(a,-999999); selected=[]
for rr in range(0,H,64):
 for cc in range(0,W,64):
  rr1=min(rr+64,H);cc1=min(cc+64,W)
  if np.max(np.abs(r[rr:rr1,cc:cc1]-a[rr:rr1,cc:cc1]))>.25:
   r0=max(0,rr-8);c0=max(0,cc-8);r1=min(H,rr1+8);c1=min(W,cc1+8)
   patch[r0:r1,c0:c1]=a[r0:r1,c0:c1];selected.append([r0,c0,r1,c1])
patchfile=P/'gf-dem-refinement-patches-1m.tif'
pf=prof.copy();pf.update(height=H,width=W,transform=t1)
with rasterio.open(patchfile,'w',**pf) as ds:ds.write(patch,1)
report['nativeDetailPatches']={'file':patchfile.name,'sha256':hashlib.sha256(patchfile.read_bytes()).hexdigest(),'bytes':patchfile.stat().st_size,'resolutionM':1,'bounds':bounds,'transform':list(t1),'sourceValidPixels':int((patch!=-999999).sum()),'nodataOutsideSelectedPatches':-999999,'selection':'64x64m source blocks with candidate reconstruction error >0.25m anywhere, plus 8m halo; exact 1m aligned reference samples, no smoothing','blockWindows':selected,'notTerrainVoids':'nodata outside refinement patches means use the separately supplied full-coverage base, NOT flat ground or missing source coverage','runtimeWarning':'Claude must design/test continuous multiresolution ground/mesh/collision integration. No final composite error claim is made here; compare final runtime query/mesh to original source, especially seams.'}
(P/'terrain-provenance-and-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('Native detail patches',patchfile.stat().st_size,'bytes; valid pixels',int((patch!=-999999).sum()),'selected blocks',len(selected))
print(json.dumps({'coverage' :report['coverage'],'errors':{k:v for k,v in report['candidateErrorVs1m'].items() if k!='worstLocations'},'anchor':anchor,'candidateBytes':out.stat().st_size},indent=2))
