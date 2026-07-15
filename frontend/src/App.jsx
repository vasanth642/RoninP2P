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
  const [filePrompt, setFilePrompt] = useState(false);


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
  const byteReceivedCount = useRef(0);
  const fileWritableStreamRef = useRef(null);

  const activeSendingFileRef = useRef(null);

  //specific file handling ref hooks for firefox
  const firefoxBufferRef = useRef([]);
  const isFirefoxBlobFallback = useRef(false);

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

  //this part is for setting up the file System access API  when the receiver receives a alert from the sender about the incoming file.
  const handleAcceptFileRequest = async () => {
    if (!incomingFileMetadata.current) return;

    setFilePrompt(false);
    byteReceivedCount.current = 0;
    setIsSenderProgress(false);
    isFirefoxBlobFallback.current = false;

    //file limit for firefox(this is the variable responsible for that purpose)
    //basically (200 MB)
    const FILE_SIZE_LIMIT_200MB = 200 * 1024 * 1024;

    if (typeof window.showSaveFilePicker !== 'function') {
      if (incomingFileMetadata.current.size > FILE_SIZE_LIMIT_200MB) {
        alert(
          `File Size Warning: ${(incomingFileMetadata.current.size / 1024 / 1024).toFixed(1)} MB\n\n` +
          "Firefox does not support direct-to-disk streaming. Large file transports require Chrome, Edge, or Brave.\n" +
          "Please reopen this link in a Chromium browser to proceed safely."
        );
        incomingFileMetadata.current = null;
        setStatus("Rejected: File too large for firefox memory.");
        setProgress(0);
        return;
      }

      isFirefoxBlobFallback.current = true;
      firefoxBufferRef.current = [];

      const acceptanceSignal = { type: 'FILE_ACCEPTED' };
      dataChannelRef.current.send(JSON.stringify(acceptanceSignal));
      setStatus('Downloading to memory buffer...');
      return;
    }

    try {
      const options = {
        suggestedName: incomingFileMetadata.current.name,
      };

      const fileHandle = await window.showSaveFilePicker(options);
      fileWritableStreamRef.current = await fileHandle.createWritable();

      const acceptanceSignal = { type: 'FILE_ACCEPTED' };
      dataChannelRef.current.send(JSON.stringify(acceptanceSignal));
      setStatus('Streaming packets directly to disk...');
    } catch (err) {
      console.log("USer denied storage access or stream creation failed:", err);
      alert("you must select a location to save the the file");
      setProgress(0);
      incomingFileMetadata.current = null;
      setStatus("Disconnected");
    }
  };

  const setupDataChannelListeners = () => {
    dataChannelRef.current.binaryType = 'arraybuffer';
    dataChannelRef.current.bufferedAmountLowThreshold = 1024 * 1024 * 4;

    dataChannelRef.current.onopen = () => {
      setStatus("Connected P2P (WebRTC Direct)");
    };

    dataChannelRef.current.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'FILE_REQUEST') {
            incomingFileMetadata.current = message;
            setFilePrompt(true);
            byteReceivedCount.current = 0;
            setStatus(`Incoming file payload: ${message.name}`);
            return;
          }

          if (message.type === 'FILE_ACCEPTED') {

            const fileToStream = activeSendingFileRef.current;
            if (!fileToStream) {
              setStatus("Error: File reference lost.");
              return;
            }
            setStatus(`Peer accepted request. Streaming ${fileToStream.name}...`);
            streamFileChunks(fileToStream);
            return;
          }
        } catch (err) {
          console.log("Plain message Text:", event.data);
        }
      }

      if (event.data instanceof ArrayBuffer) {
        if (!incomingFileMetadata.current || (!fileWritableStreamRef.current && !isFirefoxBlobFallback.current)) {
          return;
        }

        if (isFirefoxBlobFallback.current) {
          firefoxBufferRef.current.push(event.data);
        } else if (fileWritableStreamRef.current) {
          fileWritableStreamRef.current.write(event.data);
        } else {
          return;
        }

        byteReceivedCount.current += event.data.byteLength;

        //calculating raw MB amount of the file
        const receivedMB = (byteReceivedCount.current) / (1024 * 1024).toFixed(1);
        const totalMB = (incomingFileMetadata.current.size / (1024 * 1024)).toFixed(1);

        const pct = Math.round((byteReceivedCount.current / incomingFileMetadata.current.size) * 100);
        setProgress(pct);
        setStatus(`Downloading: ${receivedMB} MB / ${totalMB}`);

        if (byteReceivedCount.current >= incomingFileMetadata.current.size) {
          if (isFirefoxBlobFallback.current) {
            // Firefox Assembler Logic: Recombine array items out of memory cache
            const fileBlob = new Blob(firefoxBufferRef.current, {
              type: incomingFileMetadata.current.mimeType || 'application/octet-stream'
            });
            const downloadUrl = URL.createObjectURL(fileBlob);

            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = incomingFileMetadata.current.name;
            document.body.appendChild(link);
            link.click();

            // Garbage collect memory pointers immediately
            document.body.removeChild(link);
            URL.revokeObjectURL(downloadUrl);
            firefoxBufferRef.current = [];
            isFirefoxBlobFallback.current = false;
          } else if (fileWritableStreamRef.current) {
            // Chromium System Stream Cleanup
            fileWritableStreamRef.current.close();
            fileWritableStreamRef.current = null;
          }

          setStatus("File saved successfully directly to your drive!");
          incomingFileMetadata.current = null;
          setProgress(0);
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

  //this function will slice the file into smaller chunks and send them over the data channel
  const streamFileChunks = async (fileToStream) => {
    // 16KB chunk
    let currentOffset = 0;
    const CHUNK_SIZE = 16384;
    const HIGH_WATERMARK = 1024 * 1024 * 16;
    while (currentOffset < fileToStream.size) {
      if (dataChannelRef.current.bufferedAmount > HIGH_WATERMARK) {
        await new Promise((resolve) => {
          dataChannelRef.current.onbufferedamountlow = () => {
            dataChannelRef.current.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const sliceStart = currentOffset;
      const sliceEnd = Math.min(currentOffset + CHUNK_SIZE, fileToStream.size);
      const fileBlobSlice = fileToStream.slice(sliceStart, sliceEnd);

      const arrayBuffer = await fileBlobSlice.arrayBuffer();

      dataChannelRef.current.send(arrayBuffer);
      currentOffset += arrayBuffer.byteLength;

      const sentMB = (currentOffset / (1024 * 1024)).toFixed(1);
      const totalMB = (fileToStream.size / (1024 * 1024)).toFixed(1);

      const pct = Math.floor((currentOffset / fileToStream.size) * 100);
      setProgress(pct);
      setStatus(`uploading: ${sentMB} MB / ${totalMB} MB`);
    }


    setStatus("File sent successfully to peer device!");

  }


  const handleSendFileHeader = () => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      return alert("P2P tunnel is not open yet");
    }

    activeSendingFileRef.current = selectedFile;

    const fileRequest = {
      type: 'FILE_REQUEST',
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type
    };

    dataChannelRef.current.send(JSON.stringify(fileRequest));
    console.log("File request handshake sent to peer:", fileRequest);

    setStatus(`Waiting for peer to accept : ${selectedFile.name}`);
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
  <div className="relative min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased selection:bg-indigo-500/20 selection:text-indigo-400 overflow-x-hidden scroll-smooth">

    {/* Premium Grid Texture Overlay */}
    <div className="absolute inset-0 bg-[linear-gradient(to_right,#18181b_1px,transparent_1px),linear-gradient(to_bottom,#18181b_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-80 pointer-events-none z-0"></div>

    {/* Amplified Atmospheric Radial Color Glows - Richer Secondary Color Presets */}
    <div className="absolute top-[-10%] left-1/4 w-[800px] h-[800px] bg-indigo-600/[0.08] rounded-full blur-[160px] pointer-events-none z-0"></div>
    <div className="absolute bottom-10 right-1/4 w-[800px] h-[800px] bg-violet-500/[0.06] rounded-full blur-[160px] pointer-events-none z-0"></div>

    {/* SECTION 1: PREMIUM HERO VIEW */}
    <section className="relative min-h-screen w-full flex items-center justify-center p-6 md:px-20 z-10 border-b border-zinc-900">

      {/* NATIVE GLOBE RENDERING LAYER - Shifted right and vertically balanced to prevent left column collisions */}
      <div className="hidden lg:block absolute top-1/2 -translate-y-1/2 right-[-2%] w-[45vw] h-[80vh] opacity-35 pointer-events-none select-none overflow-hidden z-0">
        <div id="aceternity-globe-surface" className="w-full h-full relative flex items-center justify-center">
          <Globe />
        </div>
      </div>

      {/* Main Structural Layout Grid */}
      <div className="relative w-full max-w-7xl grid grid-cols-1 lg:grid-cols-12 gap-12 items-center z-10 pt-4 md:pt-0">

        {/* Left Typography Frame */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-10 text-left">

          <div className="space-y-6">
            {/* Project Brand Label - Elevated layout hierarchy and text scale */}
            <div className="text-xl tracking-[0.25em] font-mono uppercase font-bold text-indigo-400 sm:text-3xl">
              Ronin P2P
            </div>

            <h1 className="text-3xl sm:text-3xl md:text-5xl font-extrabold tracking-tight leading-[1.1] text-white">
              Direct Peer-to-Peer <br />
              File Sharing Platform
            </h1>

            <p className="text-base md:text-lg text-zinc-400 max-w-xl font-normal leading-relaxed tracking-wide">
              Bypass intermediate storage completely. Open native, memory-safe data streams straight onto your peer's drive with full hardware acceleration and unlimited allocation limits.
            </p>
          </div>

          {/* Grid of Specialized Capabilities - Expanded Card Dimensions and Font Hierarchies */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full pt-2">

            {/* Capability 1 */}
            <div className="relative p-6 min-h-[220px] flex flex-col justify-between rounded-xl border border-zinc-800/80 bg-zinc-900/10 backdrop-blur-md transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/30 group">
              <div>
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-indigo-400 mb-5 shadow-sm">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 00-5.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                </div>
                <h4 className="text-base font-semibold text-zinc-200 tracking-wide">Secure Discovery</h4>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed">Exchange structural signaling blueprints via isolated room coordinate channels.</p>
              </div>
            </div>

            {/* Capability 2 */}
            <div className="relative p-6 min-h-[220px] flex flex-col justify-between rounded-xl border border-zinc-800/80 bg-zinc-900/10 backdrop-blur-md transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/30 group">
              <div>
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-indigo-400 mb-5 shadow-sm">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                </div>
                <h4 className="text-base font-semibold text-zinc-200 tracking-wide">Dynamic Routing</h4>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed">Dynamic memory allocation handles low and high volume tracking conditions automatically.</p>
              </div>
            </div>

            {/* Capability 3 */}
            <div className="relative p-6 min-h-[220px] flex flex-col justify-between rounded-xl border border-zinc-800/80 bg-zinc-900/10 backdrop-blur-md transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/30 group">
              <div>
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-indigo-400 mb-5 shadow-sm">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" />
                  </svg>
                </div>
                <h4 className="text-base font-semibold text-zinc-200 tracking-wide">Direct Pipeline</h4>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed">Stream data packages directly to storage without cloud payload ceilings.</p>
              </div>
            </div>

          </div>

          {/* Action Call Controls - Optimized structural padding bounds to sit cleanly within view */}
          <div className="pt-4 flex flex-wrap items-center gap-5">
            <button
              onClick={handleScrollToTool}
              className="px-10 py-4.5 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white font-bold text-base rounded-xl tracking-wide transition-all duration-200 shadow-[0_4px_24px_rgba(99,102,241,0.25)]"
            >
              Launch Console
            </button>
            <a 
              href="https://github.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="px-10 py-4.5 border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/60 hover:border-zinc-700 font-bold text-base rounded-xl tracking-wide text-zinc-300 transition-all duration-200 flex items-center gap-2.5"
            >
              Explore Repository
            </a>
          </div>

        </div>

        <div className="hidden lg:block lg:col-span-5"></div>
      </div>
    </section>

    {/* SECTION 2: RUNTIME CONSOLE WORKSPACE */}
    <section 
      id="p2p-terminal-deck" 
      className="relative min-h-screen w-full flex flex-col items-center justify-center p-6 md:p-12 z-10 bg-zinc-950"
    >
      <div className="relative w-full max-w-3xl flex flex-col items-center space-y-8">
        
        <header className="text-center">
          <h2 className="text-3xl font-bold tracking-tight bg-gradient-to-b from-white to-zinc-400 bg-clip-text text-transparent">
            Ronin Console
          </h2>
        </header>

        {/* Core Main Control Deck Card Layout */}
        <main className="w-full bg-zinc-900/20 border border-zinc-800 rounded-2xl p-6 md:p-8 backdrop-blur-xl relative overflow-hidden shadow-[0_32px_64px_-16px_rgba(0,0,0,0.8)]">
          <div className="absolute top-0 inset-x-0 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent"></div>

          {/* Top Real-time Status Strip */}
          <div className="border-b border-zinc-800/80 pb-4 flex items-center justify-between relative z-10">
            <div className="space-y-1 text-left">
              <span className="text-[10px] text-zinc-500 block uppercase tracking-widest font-mono font-bold">STATUS</span>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${status.includes('Connected') ? 'bg-indigo-500 animate-pulse shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'bg-zinc-600'}`}></span>
                <span className="text-sm font-semibold tracking-wide text-zinc-200 font-mono">{status}</span>
              </div>
            </div>
          </div>

          {/* Core Operations Grid */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pt-6 relative z-10">
            
            {/* Left Controller: Keys & Invitations */}
            <div className="md:col-span-5 flex flex-col justify-between space-y-4 text-left">
              <div className="space-y-2">
                <label className="text-[10px] text-zinc-500 block uppercase tracking-widest font-mono font-bold">YOUR ROOM CODE</label>
                <div className="font-mono text-xs font-semibold text-indigo-400 select-all bg-zinc-950 border border-zinc-800 px-4 py-3 rounded-xl tracking-wider text-center shadow-inner group transition-all duration-200 hover:border-indigo-500/30">
                  {roomId || "SYNCHRONIZING..."}
                </div>
              </div>
              
              <button
                onClick={handleShareInvite}
                className="w-full py-3 bg-zinc-100 hover:bg-white active:scale-[0.99] text-zinc-950 font-bold text-xs rounded-xl tracking-wide shadow-md transition-all duration-150 font-mono"
              >
                SHARE INVITE LINK
              </button>
            </div>

            {/* Right Controller: Input Staging Gateway */}
            <div className="md:col-span-7 flex flex-col justify-center">
              <div className="relative border border-dashed border-zinc-800 bg-zinc-950/40 rounded-xl p-6 transition-all duration-300 flex flex-col items-center justify-center text-center cursor-pointer group hover:bg-zinc-900/10 hover:border-indigo-500/20 shadow-inner">
                <input
                  type="file" 
                  onChange={(e) => setSelectedFile(e.target.files[0])}
                  className="absolute inset-0 opacity-0 cursor-pointer z-20"
                />

                <div className="h-12 w-12 mb-3 flex items-center justify-center pointer-events-none transition-all duration-300 group-hover:scale-105">
                  <div className="absolute h-10 w-10 bg-zinc-900 rounded-lg border border-zinc-800 flex items-center justify-center shadow-md text-zinc-400 group-hover:text-indigo-400 group-hover:border-indigo-500/30 transition-all duration-300">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                  </div>
                </div>

                <span className="text-xs font-bold font-mono tracking-wide text-zinc-400 group-hover:text-zinc-200 transition-colors duration-200">
                  {selectedFile ? 'CHANGE SELECTED FILE' : 'SELECT FILE TO SEND'}
                </span>
              </div>
            </div>

          </div>

          {/* Dynamic Row A: Sender Asset Awaiting Dispatch */}
          {selectedFile && !status.includes("uploading") && !status.includes("Streaming") && (
            <div className="relative bg-zinc-950/80 border border-zinc-800 p-4 rounded-xl flex items-center justify-between shadow-inner mt-6 animate-fadeIn text-left">
              <div className="overflow-hidden mr-4">
                <span className="text-xs font-bold text-zinc-400 font-mono uppercase tracking-wider block">SELECTED FILE</span>
                <span className="text-sm text-zinc-100 block truncate font-semibold mt-0.5 tracking-wide">{selectedFile.name}</span>
                <span className="text-[10px] text-zinc-500 block mt-1 font-mono">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
              <button
                onClick={handleSendFileHeader}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-bold font-mono rounded-lg transition-all shadow-md tracking-wider whitespace-nowrap"
              >
                SEND FILE
              </button>
            </div>
          )}

          {/* Dynamic Row B: Receiver Acceptance Prompt */}
          {filePrompt && incomingFileMetadata.current && !fileWritableStreamRef.current && (
            <div className="relative bg-zinc-950 border border-indigo-500/20 p-4 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl mt-6 animate-fadeIn text-left">
              <div className="overflow-hidden w-full sm:w-auto">
                <span className="text-[10px] font-bold text-indigo-400 block uppercase tracking-widest font-mono">INCOMING FILE REQUEST</span>
                <span className="text-sm text-zinc-200 block truncate font-semibold mt-1 font-mono tracking-wide">{incomingFileMetadata.current.name}</span>
                <span className="text-[10px] text-zinc-500 block mt-0.5 font-mono">
                  {(incomingFileMetadata.current.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
              <button
                onClick={handleAcceptFileRequest}
                className="w-full sm:w-auto px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-bold font-mono rounded-lg transition-all shadow-md tracking-wider whitespace-nowrap"
              >
                {typeof window.showSaveFilePicker === 'function' ? 'CHOOSE LOCATION & SAVE' : 'DOWNLOAD FILE'}
              </button>
            </div>
          )}

          {/* Dynamic Row C: Active Progress Track Loops */}
          {progress > 0 && (
            <div className="bg-zinc-950 border border-zinc-900 p-4 rounded-xl space-y-3 shadow-inner mt-6 text-left">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-zinc-500 font-bold uppercase tracking-wider">TRANSFER PROGRESS</span>
                <span className="text-indigo-400 font-bold">{progress}% SENT</span>
              </div>
              <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-150 ease-out shadow-[0_0_12px_rgba(99,102,241,0.3)]"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}

        </main>
      </div>
    </section>
  </div>
);

}

export default App;