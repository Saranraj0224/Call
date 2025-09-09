import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Phone, 
  PhoneCall, 
  PhoneOff, 
  User, 
  UserCheck,
  Volume2,
  Mic,
  MicOff,
  Settings,
  MoreVertical
} from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project-url.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';
const supabase = createClient(supabaseUrl, supabaseKey);

type UserRole = 'moo' | 'boo' | null;
type CallState = 'idle' | 'calling' | 'ringing' | 'active' | 'ended';

interface CallData {
  from: UserRole;
  to: UserRole;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  action: 'call' | 'answer' | 'reject' | 'end' | 'ice-candidate';
  timestamp: number;
}

function App() {
  const [userRole, setUserRole] = useState<UserRole>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [incomingCall, setIncomingCall] = useState<CallData | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const localAudioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize WebRTC configuration
  const iceServers = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // Set up real-time subscription
  useEffect(() => {
    if (!userRole) return;

    const subscription = supabase
      .channel('voice-calls')
      .on('broadcast', { event: 'call-signal' }, (payload) => {
        const callData = payload.payload as CallData;
        if (callData.to === userRole) {
          handleIncomingSignal(callData);
        }
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [userRole]);

  // Handle incoming WebRTC signals
  const handleIncomingSignal = async (callData: CallData) => {
    switch (callData.action) {
      case 'call':
        setIncomingCall(callData);
        setCallState('ringing');
        break;
      
      case 'answer':
        if (peerConnectionRef.current && callData.answer) {
          await peerConnectionRef.current.setRemoteDescription(callData.answer);
        }
        break;
      
      case 'reject':
      case 'end':
        endCall();
        break;
      
      case 'ice-candidate':
        if (peerConnectionRef.current && callData.candidate) {
          await peerConnectionRef.current.addIceCandidate(callData.candidate);
        }
        break;
    }
  };

  // Send signaling data
  const sendSignal = (callData: Omit<CallData, 'timestamp'>) => {
    supabase.channel('voice-calls').send({
      type: 'broadcast',
      event: 'call-signal',
      payload: { ...callData, timestamp: Date.now() }
    });
  };

  // Initialize peer connection
  const initializePeerConnection = () => {
    const pc = new RTCPeerConnection(iceServers);
    
    pc.onicecandidate = (event) => {
      if (event.candidate && userRole) {
        sendSignal({
          from: userRole,
          to: userRole === 'moo' ? 'boo' : 'moo',
          action: 'ice-candidate',
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setIsConnected(true);
        setCallState('active');
        startCallTimer();
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        endCall();
      }
    };

    return pc;
  };

  // Get user media
  const getUserMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      localStreamRef.current = stream;
      return stream;
    } catch (error) {
      console.error('Error accessing microphone:', error);
      throw error;
    }
  };

  // Start outgoing call
  const startCall = async () => {
    if (!userRole) return;
    
    try {
      setCallState('calling');
      
      const stream = await getUserMedia();
      const pc = initializePeerConnection();
      peerConnectionRef.current = pc;

      // Add local stream to peer connection
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal({
        from: userRole,
        to: userRole === 'moo' ? 'boo' : 'moo',
        action: 'call',
        offer
      });

    } catch (error) {
      console.error('Error starting call:', error);
      setCallState('idle');
    }
  };

  // Accept incoming call
  const acceptCall = async () => {
    if (!incomingCall || !userRole) return;

    try {
      const stream = await getUserMedia();
      const pc = initializePeerConnection();
      peerConnectionRef.current = pc;

      // Add local stream
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // Set remote description and create answer
      if (incomingCall.offer) {
        await pc.setRemoteDescription(incomingCall.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignal({
          from: userRole,
          to: incomingCall.from,
          action: 'answer',
          answer
        });
      }

      setIncomingCall(null);
    } catch (error) {
      console.error('Error accepting call:', error);
      rejectCall();
    }
  };

  // Reject incoming call
  const rejectCall = () => {
    if (!incomingCall || !userRole) return;

    sendSignal({
      from: userRole,
      to: incomingCall.from,
      action: 'reject'
    });

    setIncomingCall(null);
    setCallState('idle');
  };

  // End call
  const endCall = () => {
    if (userRole && (callState === 'active' || callState === 'calling')) {
      sendSignal({
        from: userRole,
        to: userRole === 'moo' ? 'boo' : 'moo',
        action: 'end'
      });
    }

    // Cleanup
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    setCallState('idle');
    setCallDuration(0);
    setIsConnected(false);
    setIncomingCall(null);
    setIsMuted(false);
  };

  // Toggle mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = isMuted;
      });
      setIsMuted(!isMuted);
    }
  };

  // Start call timer
  const startCallTimer = () => {
    setCallDuration(0);
    callTimerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
  };

  // Format call duration
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Character selection screen
  if (!userRole) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-white flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="w-full max-w-sm mx-auto"
        >
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="text-center mb-8"
          >
            <div className="w-16 h-16 bg-gradient-to-br from-green-500 to-green-600 rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-lg">
              <Phone className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Hellooooo!</h1>
            <p className="text-gray-600 text-sm">Who are you?</p>
          </motion.div>

          {/* Character Cards */}
          <div className="space-y-3">
            <motion.button
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
              whileHover={{ 
                scale: 1.02,
                y: -2,
                boxShadow: "0 8px 25px rgba(34, 197, 94, 0.15)"
              }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setUserRole('moo')}
              className="w-full bg-white border border-gray-200 rounded-2xl p-4 flex items-center gap-4 shadow-sm hover:shadow-md transition-all duration-300"
            >
              <div className="w-14 h-14 bg-gradient-to-br from-green-100 to-green-200 rounded-xl flex items-center justify-center">
                <span className="text-2xl">🐄</span>
              </div>
              <div className="flex-1 text-left">
                <h3 className="font-semibold text-gray-900">Moo</h3>
                <p className="text-sm text-gray-500">The friendly one</p>
              </div>
              <User className="w-5 h-5 text-gray-400" />
            </motion.button>

            <motion.button
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              whileHover={{ 
                scale: 1.02,
                y: -2,
                boxShadow: "0 8px 25px rgba(34, 197, 94, 0.15)"
              }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setUserRole('boo')}
              className="w-full bg-white border border-gray-200 rounded-2xl p-4 flex items-center gap-4 shadow-sm hover:shadow-md transition-all duration-300"
            >
              <div className="w-14 h-14 bg-gradient-to-br from-purple-100 to-purple-200 rounded-xl flex items-center justify-center">
                <span className="text-2xl">👻</span>
              </div>
              <div className="flex-1 text-left">
                <h3 className="font-semibold text-gray-900">Boo</h3>
                <p className="text-sm text-gray-500">The mysterious one</p>
              </div>
              <UserCheck className="w-5 h-5 text-gray-400" />
            </motion.button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-white flex items-center justify-center p-4">
      <audio ref={localAudioRef} muted autoPlay />
      <audio ref={remoteAudioRef} autoPlay />
      
      {/* Phone Container */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-sm mx-auto bg-white rounded-3xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-green-500 to-green-600 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
                <span className="text-xl">{userRole === 'moo' ? '🐄' : '👻'}</span>
              </div>
              <div>
                <h2 className="text-white font-semibold capitalize">{userRole}</h2>
                <p className="text-green-100 text-xs">
                  {callState === 'active' ? 'Connected' : 'Available'}
                </p>
              </div>
            </div>
            <button className="w-8 h-8 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
              <MoreVertical className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* Main Content */}
        <div className="p-6">
          {/* Idle State */}
          {callState === 'idle' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="text-center space-y-6"
            >
              <div className="py-8">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  className="w-24 h-24 bg-gradient-to-br from-green-500 to-green-600 rounded-full mx-auto mb-4 flex items-center justify-center shadow-lg"
                >
                  <span className="text-4xl">{userRole === 'moo' ? '👻' : '🐄'}</span>
                </motion.div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  {userRole === 'moo' ? 'Boo' : 'Moo'}
                </h3>
                <p className="text-gray-500 text-sm">Ready to connect</p>
              </div>

              <motion.button
                whileHover={{ 
                  scale: 1.02,
                  boxShadow: "0 8px 25px rgba(34, 197, 94, 0.25)"
                }}
                whileTap={{ scale: 0.98 }}
                onClick={startCall}
                className="w-full bg-gradient-to-r from-green-500 to-green-600 text-white font-semibold py-4 px-6 rounded-2xl flex items-center justify-center gap-3 shadow-lg transition-all duration-300"
              >
                <Phone className="w-5 h-5" />
                Call {userRole === 'moo' ? 'Boo' : 'Moo'}
              </motion.button>

              <button
                onClick={() => setUserRole(null)}
                className="w-full text-gray-500 font-medium py-3 px-6 rounded-xl hover:bg-gray-50 transition-colors duration-200"
              >
                Switch User
              </button>
            </motion.div>
          )}

          {/* Calling State */}
          {callState === 'calling' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center space-y-6 py-8"
            >
              <div>
                <motion.div
                  animate={{ 
                    scale: [1, 1.1, 1],
                    boxShadow: [
                      "0 0 0 0 rgba(34, 197, 94, 0.4)",
                      "0 0 0 20px rgba(34, 197, 94, 0)",
                      "0 0 0 0 rgba(34, 197, 94, 0.4)"
                    ]
                  }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="w-24 h-24 bg-gradient-to-br from-green-500 to-green-600 rounded-full mx-auto mb-4 flex items-center justify-center"
                >
                  <PhoneCall className="w-8 h-8 text-white" />
                </motion.div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">Calling...</h3>
                <p className="text-gray-500">Waiting for {userRole === 'moo' ? 'Boo' : 'Moo'} to answer</p>
              </div>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={endCall}
                className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-4 px-6 rounded-2xl flex items-center justify-center gap-3 shadow-lg transition-all duration-300"
              >
                <PhoneOff className="w-5 h-5" />
                Cancel
              </motion.button>
            </motion.div>
          )}

          {/* Active Call State */}
          {callState === 'active' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              <div className="text-center py-6">
                <div className="flex items-center justify-center gap-3 mb-4">
                  <motion.div
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  >
                    <Volume2 className="w-6 h-6 text-green-500" />
                  </motion.div>
                  <SoundWave />
                </div>
                <motion.div
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  className="text-3xl font-bold text-gray-900 mb-2"
                >
                  {formatDuration(callDuration)}
                </motion.div>
                <p className="text-gray-500">Connected with {userRole === 'moo' ? 'Boo' : 'Moo'}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={toggleMute}
                  className={`${
                    isMuted 
                      ? 'bg-red-50 text-red-600 border-red-200' 
                      : 'bg-gray-50 text-gray-600 border-gray-200'
                  } border font-semibold py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all duration-300`}
                >
                  {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  {isMuted ? 'Unmute' : 'Mute'}
                </motion.button>

                <motion.button
                  whileHover={{ 
                    scale: 1.05,
                    boxShadow: "0 8px 25px rgba(239, 68, 68, 0.25)"
                  }}
                  whileTap={{ scale: 0.95 }}
                  onClick={endCall}
                  className="bg-red-500 hover:bg-red-600 text-white font-semibold py-4 px-4 rounded-xl flex items-center justify-center gap-2 shadow-lg transition-all duration-300"
                >
                  <PhoneOff className="w-5 h-5" />
                  End
                </motion.button>
              </div>
            </motion.div>
          )}
        </div>
      </motion.div>

      {/* Incoming Call Modal */}
      <AnimatePresence>
        {callState === 'ringing' && incomingCall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="bg-gradient-to-r from-green-500 to-green-600 px-6 py-8 text-center">
                <motion.div
                  animate={{ 
                    scale: [1, 1.1, 1],
                    boxShadow: [
                      "0 0 0 0 rgba(255, 255, 255, 0.4)",
                      "0 0 0 20px rgba(255, 255, 255, 0)",
                      "0 0 0 0 rgba(255, 255, 255, 0.4)"
                    ]
                  }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="w-20 h-20 bg-white bg-opacity-20 rounded-full flex items-center justify-center mx-auto mb-4"
                >
                  <PhoneCall className="w-8 h-8 text-white" />
                </motion.div>
                
                <h3 className="text-xl font-bold text-white mb-2">
                  Incoming Call
                </h3>
                <p className="text-green-100">
                  {incomingCall.from === 'moo' ? '🐄 Moo' : '👻 Boo'} is calling you
                </p>
              </div>

              <div className="p-6">
                <div className="grid grid-cols-2 gap-4">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={rejectCall}
                    className="bg-red-500 hover:bg-red-600 text-white font-semibold py-4 px-6 rounded-2xl flex items-center justify-center gap-2 shadow-lg transition-all duration-300"
                  >
                    <PhoneOff className="w-5 h-5" />
                    Reject
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={acceptCall}
                    className="bg-gradient-to-r from-green-500 to-green-600 text-white font-semibold py-4 px-6 rounded-2xl flex items-center justify-center gap-2 shadow-lg transition-all duration-300"
                  >
                    <Phone className="w-5 h-5" />
                    Accept
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Enhanced Sound wave animation component
const SoundWave = () => {
  return (
    <div className="flex items-center gap-1">
      {[...Array(4)].map((_, i) => (
        <motion.div
          key={i}
          animate={{
            scaleY: [0.5, 2, 0.5],
            opacity: [0.5, 1, 0.5]
          }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut"
          }}
          className="w-1 h-4 bg-gradient-to-t from-green-400 to-green-600 rounded-full"
        />
      ))}
    </div>
  );
};

export default App;
