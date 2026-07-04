import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Globe } from "./components/Globe";

const BACKEND_URL = "https://roninp2p.onrender.com";

const rtcConfig = {
  iceServers: [
    {
      urls: [
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302"
      ]
    }
  ]
};

function App() {
  const [status, setStatus] = useState("Diconnected");
  const [roomId, setRoomId] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [isSenderProgress, setIsSenderProgress] = useState(false);

  //ui variables dont care
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [hasRoomParam] = useState(() => !!new URLSearchParams(window.location.search).get("room"));

  useEffect(() => {
    if (hasRoomParam) {
      setTimeout(() => {
        document.getElementById('p2p-terminal-deck')?.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    }
  }, [hasRoomParam]);

  // Handler for the CTA transition element
  const handleScrollToTool = () => {
    document.getElementById('p2p-terminal-deck')?.scrollIntoView({ behavior: 'smooth' });
  };

  //variables for handling files
  const incomingFileMetadata = useRef(null);
  const receivedChunkBuffer = useRef([]);
  const byteReceivedCount = useRef(0);

  {/*
    -> socketRef holds instance of an active socket.io-client that has a open 
    connection to my backend running in port:5000
    -> the .emit() sends messsage to the server and .on() listens for messages from the server
    */}
  const socketRef = useRef(null);

  //peerConnectRef is instance of RTCPeerConnection Class
  //it handles localdescription, remoteDescription and also firewall hole-punching,STUN and peer tracking.
  const peerConnectRef = useRef(null);


  //refers to the RTCDaataChannel class, which is a sub-pipeline inside RTCPeerConnection
  const dataChannelRef = useRef(null);

  //this queue is used to stop race condition that occurs when peerA fires up coordinates even before peerB has finished setting up his remote BLueprint(peer A's sdp)
  const iceQueueRef = useRef([]);

  const roomIdRef = useRef("");

  const setupDataChannelListeners = () => {
    dataChannelRef.current.binaryType = 'arraybuffer';

    dataChannelRef.current.onopen = () => {
      setStatus("Connected P2P (WebRTC Direct)");
    };

    dataChannelRef.current.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'header') {
            incomingFileMetadata.current = message;
            receivedChunkBuffer.current = [];
            byteReceivedCount.current = 0;
            setStatus(`Incoming file payload: ${message.name}`);
            return;
          }
        } catch (err) {
          console.log("Plain message Text:", event.data);
        }
      }

      if (event.data instanceof ArrayBuffer) {
        if (!incomingFileMetadata.current) {
          return;
        }

        receivedChunkBuffer.current.push(event.data);
        byteReceivedCount.current += event.data.byteLength;
        console.log(`Received chunk: Progress ${byteReceivedCount.current} / ${incomingFileMetadata.current.size} bytes`);

        //receiver progress loading part:
        setIsSenderProgress(false);
        const pct = Math.round((byteReceivedCount.current / incomingFileMetadata.current.size) * 100);
        setProgress(pct);

        if (byteReceivedCount.current >= incomingFileMetadata.current.size) {
          setStatus(`file assembly complete! Triggering download...`);
          triggerFileDownload();
        }
      }
    };
  };

  useEffect(() => {
    //even before loading we are setting up the room 
    //scenario A: if the user is the one first entering we generate a random room id autom atically for them.
    //scenario b if the user is the one that clicked the link , then we autofill the room id for them .
    //the below coe block is the logic for that part.

    const urlParams = new URLSearchParams(window.location.search);
    const sharedRoomId = urlParams.get('room');

    if (sharedRoomId) {
      // Scenario B: You clicked a friend's link! Auto-fill the targeted room
      setRoomId(sharedRoomId);
      roomIdRef.current = sharedRoomId;
    } else {
      // Scenario A: You opened the app fresh! Auto-create a random room code
      const automaticCode = generateRandomRoomId();
      setRoomId(automaticCode);
      roomIdRef.current = automaticCode;
    }

    socketRef.current = io(BACKEND_URL);

    socketRef.current.on('connect', () => {
      setStatus("Connected to signaling server");
      socketRef.current.emit('join-room', roomIdRef.current);
    })

    socketRef.current.on('peer-joined', async (peerId) => {
      console.log(`A peer has entered the room! Their Id is: ${peerId}`);
      console.log(`Initializing WebRTC for: ${peerId}`);

      peerConnectRef.current = new RTCPeerConnection(rtcConfig);

      dataChannelRef.current = peerConnectRef.current.createDataChannel("fileTransfer");
      setupDataChannelListeners();

      peerConnectRef.current.onicecandidate = (e) => {
        if (e.candidate) {
          socketRef.current.emit('ice-candidate', { roomId: roomIdRef.current, candidate: e.candidate });
        }
      };

      const offer = await peerConnectRef.current.createOffer();
      await peerConnectRef.current.setLocalDescription(offer);

      socketRef.current.emit('sdp-signal', { roomId: roomIdRef.current, sdp: offer });
    });

    socketRef.current.on('sdp-signal', async (sdp) => {
      console.log("Received an SDP blueprint from across the room...");

      if (!peerConnectRef.current) {
        peerConnectRef.current = new RTCPeerConnection(rtcConfig);

        peerConnectRef.current.onicecandidate = (e) => {
          if (e.candidate) {
            socketRef.current.emit('ice-candidate', { roomId: roomIdRef.current, candidate: e.candidate });
          }
        };

        peerConnectRef.current.ondatachannel = (event) => {
          console.log('Peer B intercepted the data pipe!');
          dataChannelRef.current = event.channel;
          setupDataChannelListeners();
        };
      }


      await peerConnectRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      while (iceQueueRef.current.length > 0) {
        const queuedCandidate = iceQueueRef.current.shift(); // Pull out the first waiting item
        await peerConnectRef.current.addIceCandidate(new RTCIceCandidate(queuedCandidate));
      }

      if (sdp.type == 'offer') {
        const answer = await peerConnectRef.current.createAnswer();
        await peerConnectRef.current.setLocalDescription(answer);

        socketRef.current.emit('sdp-signal', { roomId: roomIdRef.current, sdp: answer });
      }
    });


    //while the blueprints are getting traded off,
    //STUN coordinates are constantly fired from peerA -> peerB and vice versa.
    //the below listener will catch that coordinate and try to send a data-packet to that coordiante instantly
    //it will try this again and again till a  dataChannel is found and pipeline gets alive.
    socketRef.current.on('ice-candidate', async (candidate) => {
      console.log("Received a STUN coordinate pathway from  across the room...");

      if (!peerConnectRef.current || !peerConnectRef.current.remoteDescription) {
        iceQueueRef.current.push(candidate);
      } else {
        await peerConnectRef.current.addIceCandidate(new RTCIceCandidate(candidate));

      }
    });

    return () => {
      socketRef.current.disconnect();
    };
  }, []);

  const handleJoinRoom = () => {
    if (!roomId) return alert("please enter a room name first!");

    roomIdRef.current = roomId;

    //this code  assists to join a new room without refreshing by deleting the existing room reference and setting it to null
    if (peerConnectRef.current) {
      peerConnectRef.current.close(); // Tells the browser to physically tear down the P2P radio link
      peerConnectRef.current = null;  // Sets the reference back to empty so it can re-initialize
    }

    //this block is to stop any existing data channels as well
    if (dataChannelRef.current) {
      dataChannelRef.current.close(); // Closes the data pipe cleanly
      dataChannelRef.current = null;
    }

    socketRef.current.emit('join-room', roomId);
    setStatus(`Joined Room: ${roomId}`);
  }

  const handleSendMessage = () => {
    if (dataChannelRef.current && dataChannelRef.current.readyState == 'open') {
      dataChannelRef.current.send("Hello directly from tab to tab!");
    } else {
      alert("P2P tunnel is not open yet");
    }
  }

  //this function helps to generate invite link and also to share it.
  //here i have used the web share api and copying the link to clipboard as a  fallback behaviour since web share api is not supported in many browsers 
  const handleShareInvite = async () => {
    if (!roomIdRef.current) {
      alert("Space connection is not initialized yet!.");
    }

    const inviteUrl = `${window.origin}?room=${roomIdRef.current}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Room!',
          text: 'Connect directly tab to tab and share files safely:',
          url: inviteUrl,
        });
        console.log("System share sheet opened successfully");
      } catch (err) {
        console.log("Share sheet dismissed:", err);
      }
    } else {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        alert(`Invite link copied to clipboard! Send this to your friend:\n${inviteUrl}`);
      } catch (clipboardErr) {
        alert(`Could not copy link automatically. Manually share this space code: ${roomIdRef.current}`);
      }
    }
  }

  ///this function below handles downloading files
  const triggerFileDownload = () => {
    if (!incomingFileMetadata.current) {
      return;
    }

    const fileBlob = new Blob(receivedChunkBuffer.current, { type: incomingFileMetadata.current.mimeType });
    const downloadUrl = URL.createObjectURL(fileBlob);

    const linkNode = document.createElement('a');
    linkNode.href = downloadUrl;
    linkNode.download = incomingFileMetadata.current.name;
    document.body.appendChild(linkNode);
    linkNode.click();
    document.body.removeChild(linkNode);
    URL.revokeObjectURL(downloadUrl);

    incomingFileMetadata.current = null;
    receivedChunkBuffer.current = [];
    byteReceivedCount.current = 0;

    setStatus('File download complete!');
    setProgress(0);
  }

  //this function will slice the file into smaller chunks and send them over the data channel
  const streamFileChunks = (file) => {
    const fileReader = new FileReader();
    let currentOffset = 0;
    const CHUNK_SIZE = 16384; // 16KB chunks

    fileReader.onload = (e) => {
      const bufferSlice = e.target.result;
      dataChannelRef.current.send(bufferSlice);
      currentOffset += bufferSlice.byteLength;

      //sender progress loading part:
      setIsSenderProgress(true);
      const pct = Math.floor((currentOffset / file.size) * 100);
      setProgress(pct);

      if (currentOffset < file.size) {
        loadNextChunkSlice();
      } else {
        setStatus(`File sent fully`);
      }
    };

    const loadNextChunkSlice = () => {
      const sliceStart = currentOffset;
      const sliceEnd = Math.min(currentOffset + CHUNK_SIZE, file.size);
      const fileBlobSlice = file.slice(sliceStart, sliceEnd);
      fileReader.readAsArrayBuffer(fileBlobSlice);
    };

    loadNextChunkSlice();
  }


  const handleSendFileHeader = () => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      return alert("P2P tunnel is not open yet");
    }

    const headerInfo = {
      type: 'header',
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type
    };

    dataChannelRef.current.send(JSON.stringify(headerInfo));

    console.log("Metadata manifest handshake dispatched over the pipe", headerInfo);
    setStatus(`Streaming the file: ${selectedFile.name}...`);
    streamFileChunks(selectedFile);
  }

  //this function helps tpo generate random room names
  const generateRandomRoomId = () => {
    const words = ['cyber', 'vortex', 'ronin', 'mesh', 'nexus', 'sonic', 'aurora', 'shadow', 'orbit', 'plasma'];
    const randomWord1 = words[Math.floor(Math.random() * words.length)];
    const randomWord2 = words[Math.floor(Math.random() * words.length)];
    const randomNum = Math.floor(1000 + Math.random() * 9000); // 4-digit numeric pin tail
    return `${randomWord1}-${randomWord2}-${randomNum}`;
  };

  return (
  <div className="relative min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased selection:bg-white/10 selection:text-white overflow-x-hidden scroll-smooth">
    
    {/* Deep Premium Ambient Background Glow */}
    <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-zinc-800/[0.03] rounded-full blur-[120px] pointer-events-none z-0"></div>

    {/* SECTION 1: PREMIUM MARKETING LANDING VIEW */}
    <section className="relative min-h-screen w-full flex items-center justify-center p-4 md:p-12 z-10 border-b border-zinc-900/50">
      
      {/* ACETERNITY GLOBE MOUNT LAYER */}
      <div className="absolute bottom-0 right-0 md:bottom-[-5%] md:right-[-5%] w-full md:w-[50vw] h-[50vh] md:h-[85vh] opacity-30 md:opacity-45 pointer-events-none select-none overflow-hidden z-0">
        <div id="aceternity-globe-surface" className="w-full h-full relative flex items-center justify-center">
          <Globe />
          <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent"></div>
        </div>
      </div>

      {/* Main Structural Layout Grid for Landing Content */}
      <div className="relative w-full max-w-6xl grid grid-cols-1 md:grid-cols-12 gap-8 items-center z-10">
        
        {/* Main Copy Deck Frame */}
        <div className="md:col-span-7 flex flex-col justify-center space-y-8 text-left pt-6">

          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.15] text-zinc-100">
            Share files globally. <br />
            <span className="bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
              Directly to your peers.
            </span>
          </h1>

          <p className="text-sm md:text-base text-zinc-400 max-w-xl font-normal leading-relaxed">
            Eliminate intermediary storage servers. Establish real-time data channels directly from device to device with absolute encryption security, unlimited payload bounds, and zero infrastructure overhead.
          </p>

          {/* Premium 3-Step Interactive Cards Grid - Upscaled text and borders */}
          <div className="pt-2 grid grid-cols-1 md:grid-cols-3 gap-5">
            
            {/* Card 1 */}
            <div className="relative p-6 rounded-xl border border-zinc-800/60 bg-zinc-900/10 backdrop-blur-sm transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/20 hover:-translate-y-1 group">
              {/* Card Badge Icon Ring */}
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 mb-4 transition-colors group-hover:border-zinc-700">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-zinc-200 tracking-wide">Initialize & Share</h4>
                <p className="text-xs text-zinc-500 font-normal leading-relaxed">Generate a secure workspace link and transmit it directly to a remote peer.</p>
              </div>
            </div>

            {/* Card 2 */}
            <div className="relative p-6 rounded-xl border border-zinc-800/60 bg-zinc-900/10 backdrop-blur-sm transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/20 hover:-translate-y-1 group">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 mb-4 transition-colors group-hover:border-zinc-700">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.536 9.636a3 3 0 000 4.728m2.828-7.556a7 7 0 000 10.384M12 13a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-zinc-200 tracking-wide">Establish Connection</h4>
                <p className="text-xs text-zinc-500 font-normal leading-relaxed">Wait for the lightweight signaling pipeline to link your browser runtimes.</p>
              </div>
            </div>

            {/* Card 3 */}
            <div className="relative p-6 rounded-xl border border-zinc-800/60 bg-zinc-900/10 backdrop-blur-sm transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/20 hover:-translate-y-1 group">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 mb-4 transition-colors group-hover:border-zinc-700">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                </svg>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-zinc-200 tracking-wide">Stream Cargo</h4>
                <p className="text-xs text-zinc-500 font-normal leading-relaxed">Dispatch payloads straight into safe client-side RAM sandbox channels.</p>
              </div>
            </div>

          </div>

          {/* Action Trigger Interface Layout Deck - Expanded button sizes */}
          <div className="pt-4 flex flex-wrap items-center gap-4">
            <button
              onClick={handleScrollToTool}
              className="px-7 py-3.5 bg-zinc-100 hover:bg-zinc-200 active:scale-[0.98] text-zinc-950 font-medium text-sm rounded-lg tracking-wide transition-all shadow-md"
            >
              Get Started
            </button>
            <a 
              href="https://github.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="px-7 py-3.5 border border-zinc-800 bg-zinc-900/20 hover:bg-zinc-900/50 font-medium text-sm rounded-lg tracking-wide text-zinc-300 transition-all flex items-center gap-2"
            >
              Technical Source
            </a>
          </div>

        </div>

        <div className="hidden md:block md:col-span-5"></div>
      </div>
    </section>

    {/* SECTION 2: APPLICATION ENGINE WORKSPACE CONTAINER */}
    <section 
      id="p2p-terminal-deck" 
      className="relative min-h-screen w-full flex flex-col items-center justify-center p-4 md:p-8 z-10 bg-zinc-950"
    >
      <div className="relative z-10 w-full max-w-xl flex flex-col items-center">
        
        {/* Workspace Mini Title Block */}
        <header className="mb-6 text-center">
          <h2 className="text-xl font-medium tracking-tight text-zinc-200">
            RoninP2P Utility Hub
          </h2>
          <p className="text-zinc-500 text-[11px] font-normal tracking-wide mt-1">
            Active Workspace Sandbox Environment
          </p>
        </header>

        {/* Core Control Dashboard Box Asset */}
        <main className="w-full bg-zinc-900/40 border border-zinc-900 rounded-2xl shadow-2xl p-6 space-y-6 transition-all">
          
          {/* Connection Telemetry Bar */}
          <div className="border-b border-zinc-800/60 pb-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] text-zinc-500 block uppercase tracking-wider font-medium">System Link Status</span>
              <span className="text-xs font-medium text-zinc-300">{status}</span>
            </div>
            <div className={`h-2 w-2 rounded-full ${status.includes('Connected') ? 'bg-zinc-400' : 'bg-zinc-800'}`}></div>
          </div>

          {/* Dynamic Space Key Box */}
          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-3.5">
            <div className="space-y-1.5 w-full">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium block">Active Gateway Key</span>
              <span className="text-sm font-medium text-zinc-300 select-all bg-zinc-900/40 px-3 py-1.5 rounded-lg border border-zinc-800/40 block">
                {roomId}
              </span>
            </div>
            
            <button
              onClick={handleShareInvite}
              className="w-full py-2.5 bg-zinc-100 hover:bg-zinc-200 active:scale-[0.99] text-zinc-950 font-medium text-xs rounded-lg tracking-wide transition-all"
            >
              Generate Invite Link
            </button>
          </div>

          {/* Secure Local Dropzone Container */}
          <div className="space-y-3">
            <div className="relative border border-dashed border-zinc-800 hover:border-zinc-700 bg-zinc-950/20 hover:bg-zinc-950/40 rounded-xl p-6 transition-all flex flex-col items-center justify-center text-center cursor-pointer group">
              <input
                type="file" 
                onChange={(e) => setSelectedFile(e.target.files[0])}
                className="absolute inset-0 opacity-0 cursor-pointer z-20"
              />

              {/* Stacked File Layout Visual */}
              <div className="relative h-14 w-14 mb-4 flex items-center justify-center pointer-events-none">
                <div className="absolute inset-0 bg-zinc-800/20 rounded-xl border border-zinc-800/30 rotate-12 scale-95 group-hover:rotate-6 group-hover:translate-y-[-2px] transition-all duration-300"></div>
                <div className="absolute inset-0 bg-zinc-900/60 rounded-xl border border-zinc-800 flex items-center justify-center shadow-md backdrop-blur-sm group-hover:scale-105 transition-all duration-300">
                  <svg className="h-5 w-5 text-zinc-500 group-hover:text-zinc-300 transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
              </div>

              <span className="text-xs font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors">
                {selectedFile ? 'Change Target File' : 'Select Local File Payload'}
              </span>
              <span className="text-[10px] text-zinc-600 mt-1.5 tracking-wide">Files remain strictly in local RAM sandbox</span>
            </div>

            {/* Active Cargo Staging Manifest Card */}
            {selectedFile && (
              <div className="bg-zinc-950 border border-zinc-900 p-4 rounded-xl flex items-center justify-between shadow-xl">
                <div className="overflow-hidden mr-3">
                  <span className="text-xs text-zinc-300 block truncate font-medium">{selectedFile.name}</span>
                  <span className="text-[10px] text-zinc-500 block mt-1">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
                <div className="overflow-hidden mr-3">
                  <span className="text-xs text-zinc-300 block truncate font-medium">{selectedFile.name}</span>
                  <span className="text-[10px] text-zinc-500 block mt-1">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
                <button
                  onClick={handleSendFileHeader}
                  className="px-4 py-2 bg-zinc-100 hover:bg-zinc-200 active:scale-95 text-zinc-950 text-xs font-medium rounded-lg transition-all shadow-md"
                >
                  Dispatch
                </button>
              </div>
            )}
          </div>

          {/* Conditional Progress Bar Block */}
          {progress > 0 && isSenderProgress && (
            <div className="bg-zinc-950 border border-zinc-900 p-4 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between text-[10px] tracking-wide">
                <span className="text-zinc-500 font-medium">Streaming Packet Train</span>
                <span className="text-zinc-300 font-medium">{progress}%</span>
              </div>
              <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-zinc-400 rounded-full transition-all duration-150 ease-out"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}

        </main>

        {/* Security Signature Footer */}
        <footer className="mt-12 text-[10px] text-zinc-600 tracking-wider uppercase select-none opacity-50 text-center">
          Protected E2EE Data Node Tunnel // Verified Direct Stream
        </footer>

      </div>
    </section>

  </div>
);

}

export default App;