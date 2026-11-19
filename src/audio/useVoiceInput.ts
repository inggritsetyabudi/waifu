import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface RecognitionEvent { id:string; kind:"authorizing"|"listening"|"partial"|"final"|"error"|"stopped"; text:string }

/** Explicit conversation mode. Renew native sessions; pause capture during AI output. */
export function useVoiceInput(onFinal:(text:string)=>void, onError:(message:string)=>void, paused=false) {
  const [enabled,setEnabled]=useState(false);
  const enabledRef=useRef(false);
  const pausedRef=useRef(paused); pausedRef.current=paused;
  const [state,setState]=useState<"idle"|"authorizing"|"listening">("idle");
  const [status,setStatus]=useState("");
  const [transcript,setTranscript]=useState("");
  const session=useRef<string|null>(null);
  const callbacks=useRef({onFinal,onError}); callbacks.current={onFinal,onError};
  const mounted=useRef(true);
  const off=useRef<(()=>void)|null>(null);
  const release=async()=>{
    const wasActive=session.current!==null;
    session.current=null; off.current?.(); off.current=null;
    if(mounted.current) {setState("idle");setTranscript("");setStatus("");}
    if(wasActive) await invoke("cmd_stop_listening").catch(()=>{});
  };
  const stop=async()=>{
    enabledRef.current=false;
    if(mounted.current) setEnabled(false);
    await release();
  };
  const fail=(message:string)=>{
    enabledRef.current=false; setEnabled(false);
    callbacks.current.onError(message);
  };
  const begin=async()=>{
    if(session.current || !mounted.current || !enabledRef.current || pausedRef.current) return;
    const id=`speech-${crypto.randomUUID()}`;
    session.current=id;
    setState("authorizing");setTranscript("");setStatus("Meminta izin mikrofon…");
    try {
      const unlisten=await listen<RecognitionEvent>("speech://event",({payload:event})=>{
        if(session.current!==event.id || !mounted.current) return;
        if(event.kind==="authorizing") {setState("authorizing");setStatus(event.text || "Meminta izin mikrofon…");}
        if(event.kind==="listening") {setState("listening");setStatus("Mendengarkan…");}
        if(event.kind==="partial") setTranscript(event.text);
        if(["final","error","stopped"].includes(event.kind)) {
          session.current=null;off.current?.();off.current=null;
          setState("idle");setTranscript("");setStatus("");
          if(event.kind==="final" && event.text.trim()) callbacks.current.onFinal(event.text.trim());
          if(event.kind==="error") fail(event.text);
        }
      });
      if(session.current!==id || !mounted.current || !enabledRef.current || pausedRef.current) {unlisten();return;}
      off.current=unlisten;
      await invoke("cmd_start_listening",{id});
    } catch(error) {
      if(session.current===id) {
        await release();
        if(mounted.current && enabledRef.current) fail(String(error));
      }
    }
  };
  const beginRef=useRef(begin);beginRef.current=begin;
  const releaseRef=useRef(release);releaseRef.current=release;
  useEffect(()=>{
    mounted.current=true;
    return ()=>{mounted.current=false;enabledRef.current=false;void releaseRef.current();};
  },[]);
  useEffect(()=>{
    if(!enabled) return;
    if(paused) {void releaseRef.current();return;}
    if(state!=="idle") return;
    // Allow output audio to settle before opening a fresh recognition session.
    const timer=setTimeout(()=>void beginRef.current(),650);
    return ()=>clearTimeout(timer);
  },[enabled,paused,state]);
  const start=async()=>{
    enabledRef.current=true;setEnabled(true);
    await beginRef.current();
  };
  return {state,status:enabled && state==="idle" ? (paused?"Menunggu Vivian selesai…":"Menyambungkan mikrofon…"):status,
    transcript,start,stop,pause:release,enabled,active:state!=="idle"};
}
