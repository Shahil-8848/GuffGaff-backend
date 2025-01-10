export type ConnectionState = {
    socketId: string;
    inCall: boolean;
    room: string | null;
    connectedAt: string;
    lastActive: string;
    connectionAttempts: number;
    lastConnectionAttempt: string | null;
  };
  export type RoomState = {
    participants: string[];
    createdAt: string;
    lastActivity: string;
    connectionStatus: 'connecting' | 'connected' | 'failed';
  };