export interface UserState {
    inCall: boolean;
    room: string | null;
    connectedAt: string;
    lastActive: string;
    connectionAttempts: number;
  }
  
  export interface RoomState {
    participants: string[];
    createdAt: string;
    lastActivity: string;
    connectionStatus: 'connecting' | 'connected' | 'failed';
  }
  
  export interface MatchData {
    timestamp: string;
    roomId: string;
    matchId: string;
    peerId: string;
    isInitiator: boolean;
  }
  
  export interface ConnectionStats {
    totalUsers: number;
    waitingUsers: number;
    activePartnerships: number;
  }