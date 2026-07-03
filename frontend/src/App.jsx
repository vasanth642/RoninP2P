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
        if(byteReceivedCount.current >= incomingFileMetadata.current.size){
          setStatus(`file assembly complete! Triggering download...`);
          triggerFileDownload();
        }
      } 
    };
  };

  useEffect(() => {
    socketRef.current = io(BACKEND_URL);

    socketRef.current.on('connect', () => {
      setStatus(`Connect to Server(ID: ${socketRef.current.id})`);
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
 
  return(
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>RoninMesh P2P File Sharing 🚀</h1>
      <p><strong>Status:</strong> {status}</p>
      
      <div>
        <input 
          type="text" 
          placeholder="Enter Room ID Name" 
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
        />
        <button onClick={handleJoinRoom}>Join / Create Room</button>
        <button onClick={handleSendMessage} style={{marginLeft: "10px"}}>Send test P2P</button>
      </div>

      //file sharing part of the file
      <div style={{ marginTop: '20px', padding: '15px', background: '#f9f9f9', borderRadius: '8px' }}>
        <h3>Share a Local File</h3>
        <input
          type="file" onChange={(e) => setSelectedFile(e.target.files[0])}
          style={{ display: 'block', marginBottom: '10px' }}
        />
        {
          selectedFile && (
            <p style={{fontSize: '14px', color: '#555'}}>
              <strong>Selected:</strong> {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )
        }

        <button
        onClick={handleSendFileHeader} disabled={!selectedFile} 
        style={{ padding: '8px 16px', background: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}>
          Send File
        </button>
      </div>
    </div>
  );

}

export default App;