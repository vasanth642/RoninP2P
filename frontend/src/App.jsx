import React, {useState, useEffect, useRef} from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = "http://localhost:5000";

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

function App(){
  const [status,setStatus] = useState("Diconnected");
  const [roomId,setRoomId] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [isSenderProgress, setIsSenderProgress] = useState(false);

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
      if(typeof event.data === 'string'){
        try{
          const message = JSON.parse(event.data);
          if(message.type === 'header'){
            incomingFileMetadata.current = message;
            receivedChunkBuffer.current = [];
            byteReceivedCount.current = 0;
            setStatus(`Incoming file payload: ${message.name}`);
            return;
          }
        } catch (err){
          console.log("Plain message Text:", event.data);
        }
      }

      if(event.data instanceof ArrayBuffer){
        if(!incomingFileMetadata.current){
          return;
        }

        receivedChunkBuffer.current.push(event.data);
        byteReceivedCount.current += event.data.byteLength;
        console.log(`Received chunk: Progress ${byteReceivedCount.current} / ${incomingFileMetadata.current.size} bytes`);

        //receiver progress loading part:
        setIsSenderProgress(false);
        const pct = Math.round((byteReceivedCount.current / incomingFileMetadata.current.size) * 100);
        setProgress(pct);

        if(byteReceivedCount.current >= incomingFileMetadata.current.size){
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
      socketRef.current.emit('join-room',roomIdRef.current);
    })

    socketRef.current.on('peer-joined', async (peerId) => {
      console.log(`A peer has entered the room! Their Id is: ${peerId}`);
      console.log(`Initializing WebRTC for: ${peerId}`);

      peerConnectRef.current = new RTCPeerConnection(rtcConfig);

      dataChannelRef.current = peerConnectRef.current.createDataChannel("fileTransfer");
      setupDataChannelListeners();

      peerConnectRef.current.onicecandidate = (e) => {
        if(e.candidate){
          socketRef.current.emit('ice-candidate', {roomId : roomIdRef.current, candidate: e.candidate});
        }
      };

      const offer =await peerConnectRef.current.createOffer();
      await peerConnectRef.current.setLocalDescription(offer);
 
      socketRef.current.emit('sdp-signal', {roomId: roomIdRef.current, sdp: offer});
    });

    socketRef.current.on('sdp-signal',async (sdp) => {
      console.log("Received an SDP blueprint from across the room...");

      if(!peerConnectRef.current){
        peerConnectRef.current = new RTCPeerConnection(rtcConfig);

        peerConnectRef.current.onicecandidate = (e) => {
          if(e.candidate){
            socketRef.current.emit('ice-candidate', {roomId: roomIdRef.current, candidate: e.candidate});
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

      if(sdp.type == 'offer'){
        const answer = await peerConnectRef.current.createAnswer();
        await peerConnectRef.current.setLocalDescription(answer);

        socketRef.current.emit('sdp-signal', {roomId: roomIdRef.current, sdp: answer});
      }
    });
    

    //while the blueprints are getting traded off,
    //STUN coordinates are constantly fired from peerA -> peerB and vice versa.
    //the below listener will catch that coordinate and try to send a data-packet to that coordiante instantly
    //it will try this again and again till a  dataChannel is found and pipeline gets alive.
    socketRef.current.on('ice-candidate', async (candidate) => {
      console.log("Received a STUN coordinate pathway from  across the room...");

      if(!peerConnectRef.current || !peerConnectRef.current.remoteDescription){
        iceQueueRef.current.push(candidate);
      }else{
        await peerConnectRef.current.addIceCandidate(new RTCIceCandidate(candidate));

      }
    });

    return () => {
      socketRef.current.disconnect();
    };
  }, []);

  const handleJoinRoom = () => {
    if(!roomId) return alert("please enter a room name first!");

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

    socketRef.current.emit('join-room',roomId);
    setStatus(`Joined Room: ${roomId}`);
  }

  const handleSendMessage = () => {
    if(dataChannelRef.current && dataChannelRef.current.readyState == 'open'){
      dataChannelRef.current.send("Hello directly from tab to tab!");
    }else{
      alert("P2P tunnel is not open yet");
    }
  }

  //this function helps to generate invite link and also to share it.
  //here i have used the web share api and copying the link to clipboard as a  fallback behaviour since web share api is not supported in many browsers 
  const handleShareInvite = async () => {
    if(!roomIdRef.current){
      alert("Space connection is not initialized yet!.");
    }

    const inviteUrl = `${window.origin}?room=${roomIdRef.current}`;

    if(navigator.share){
      try{
        await navigator.share({
          title: 'Join my Room!',
          text: 'Connect directly tab to tab and share files safely:',
          url: inviteUrl,
        });
        console.log("System share sheet opened successfully");
      }catch(err){
        console.log("Share sheet dismissed:", err);
      }
    }else{
      try {
        await navigator.clipboard.writeText(inviteUrl);
        alert(`Invite link copied to clipboard! Send this to your friend:\n${inviteUrl}`);
      }catch (clipboardErr) {
        alert(`Could not copy link automatically. Manually share this space code: ${roomIdRef.current}`);
      }
    }
  }
 
  ///this function below handles downloading files
  const triggerFileDownload = () => {
    if(!incomingFileMetadata.current){
      return;
    }

    const fileBlob = new Blob(receivedChunkBuffer.current, {type: incomingFileMetadata.current.mimeType});
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

      if(currentOffset < file.size){
        loadNextChunkSlice();
      }else{
        setStatus(`File sent fully`);
      }
    };

    const loadNextChunkSlice = () => {
      const sliceStart = currentOffset;
      const sliceEnd = Math.min(currentOffset + CHUNK_SIZE, file.size);
      const fileBlobSlice = file.slice(sliceStart,sliceEnd);
      fileReader.readAsArrayBuffer(fileBlobSlice);
    };

    loadNextChunkSlice();
  }


  const handleSendFileHeader = () => {
    if(!dataChannelRef.current || dataChannelRef.current.readyState !== 'open'){
      return alert("P2P tunnel is not open yet");
    }

    const headerInfo = {
      type: 'header',
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType : selectedFile.type
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-6 font-sans antialiased selection:bg-emerald-500/20 selection:text-emerald-400">
      
      {/* App Header */}
      <header className="mb-8 text-center">
        <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-zinc-800 bg-zinc-900/50 text-[11px] font-mono text-zinc-400 mb-3 tracking-wider uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          Direct Tab-To-Tab File Transfer Pipe
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-100">
          Ronin<span className="text-emerald-400 font-mono font-normal">P2P</span>
        </h1>
        <p className="text-zinc-500 text-xs mt-1">Serverless, end-to-end file sharing engine.</p>
      </header>

      {/* Main Terminal Dashboard Card */}
      <main className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl p-5 space-y-5">
        
        {/* Connection Telemetry Bar (Ping Button Removed) */}
        <div className="border-b border-zinc-800 pb-3">
          <span className="text-[10px] font-mono text-zinc-500 block uppercase tracking-wider">System Link Status</span>
          <span className="text-xs font-semibold text-zinc-300 font-mono">{status}</span>
        </div>

        {/* Dynamic Space Key Box */}
        <div className="bg-zinc-950 border border-zinc-800/60 rounded-lg p-4 flex flex-col items-center justify-center text-center space-y-3">
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono block">Active Gateway Key</span>
            <span className="text-sm font-mono font-bold text-zinc-200 tracking-wide select-all bg-zinc-900 px-3 py-1 rounded border border-zinc-800 block">
              {roomId}
            </span>
          </div>
          
          <button
            onClick={handleShareInvite}
            className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 active:scale-[0.99] text-zinc-950 font-semibold text-xs font-mono rounded tracking-wide transition-all uppercase"
          >
            Generate Invite Link
          </button>
        </div>

        {/* Secure Local Dropzone Container */}
        <div className="space-y-3">
          <div className="relative border border-dashed border-zinc-800 hover:border-zinc-700 bg-zinc-950/20 rounded-lg p-5 transition-all flex flex-col items-center justify-center text-center cursor-pointer">
            <input
              type="file" 
              onChange={(e) => setSelectedFile(e.target.files[0])}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <span className="text-xs font-mono font-medium text-zinc-400">
              {selectedFile ? 'Change Target File' : 'Select Local File Payload'}
            </span>
            <span className="text-[10px] font-mono text-zinc-600 mt-1">Files remain strictly in local RAM sandbox</span>
          </div>

          {/* Active Cargo Staging Manifest Card */}
          {selectedFile && (
            <div className="bg-zinc-950 border border-zinc-800 p-3 rounded-lg flex items-center justify-between transition-all">
              <div className="overflow-hidden mr-2">
                <span className="text-xs font-mono text-zinc-300 block truncate">{selectedFile.name}</span>
                <span className="text-[10px] text-zinc-500 font-mono block mt-0.5">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
              <button
                onClick={handleSendFileHeader}
                className="px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 active:scale-95 text-zinc-950 text-xs font-mono font-bold rounded transition-all tracking-wide uppercase flex-shrink-0"
              >
                Dispatch
              </button>
            </div>
          )}
        </div>

        {/* Conditional Progress Bar: Only visible on the Sender's side */}
        {progress > 0 && isSenderProgress && (
          <div className="bg-zinc-950 border border-zinc-800 p-3 rounded-lg space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-wide">
              <span className="text-zinc-500 uppercase">Streaming Packet Train</span>
              <span className="text-emerald-400 font-bold">{progress}%</span>
            </div>
            <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div 
                className="h-full bg-emerald-400 rounded-full transition-all duration-150 ease-out"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </div>
        )}

      </main>

      {/* Security Signature Footer */}
      <footer className="mt-8 font-mono text-[9px] text-zinc-600 tracking-widest uppercase">
        Protected E2EE Data Node Tunnel
      </footer>
    </div>
  );

}

export default App;