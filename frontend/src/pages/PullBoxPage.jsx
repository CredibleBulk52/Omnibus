import React,{useEffect,useState} from 'react';
import {Link,Navigate} from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import {Loading,ErrorNote} from '../components/StateMessage';
import {pullRequest,FavoritesMigration} from '../components/PullBox';
export default function PullBoxPage(){
 const [data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;pullRequest().then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 if(error)return <ErrorNote>{error}</ErrorNote>;if(!data)return <Loading label="Opening My Pull Box…"/>;
 if(data.box&&!data.favoritesCount)return <Navigate to={'/collections/'+data.box.id} replace/>;
 return <div><PageHeader title="My Pull Box"/><div className="pull-intro"><img src="/pull-box-art.png" alt="My Pull Box"/><div><FavoritesMigration count={data.favoritesCount} onChange={setData}/><h2>Your series. Your next issues.</h2><p>Choose + Pull on a series to keep it here. My Pulls on Home shows available releases from those series across all libraries.</p>{data.box?<Link className="btn btn-primary" to={'/collections/'+data.box.id}>Open My Pull Box →</Link>:<Link className="btn btn-primary" to="/series">Find a series to pull →</Link>}</div></div></div>;
}
