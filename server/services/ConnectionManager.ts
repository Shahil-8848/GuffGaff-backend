import { UserState, RoomState, ConnectionStats } from '../types/ConnectionTypes';

export class ConnectionManager {
  private users: Map<string, UserState>;
  private partnerships: Map<string, string>;
  private waitingQueue: string[];
  private roomCounter: number;
  private rooms: Map<string, RoomState>;
  private readonly MAX_CONNECTION_ATTEMPTS = 3;
  private readonly CONNECTION_TIMEOUT = 30000;

  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
  }

  public addUser(socketId: string): boolean {
    if (!this.users.has(socketId)) {
      this.users.set(socketId, {
        inCall: false,
        room: null,
        connectedAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        connectionAttempts: 0
      });
      return true;
    }
    return false;
  }

  public removeUser(socketId: string): void {
    const user = this.users.get(socketId);
    if (user && user.room) {
      this.breakPartnership(socketId);
    }
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
  }

  public addToWaitingQueue(socketId: string): boolean {
    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      return true;
    }
    return false;
  }

  public removeFromWaitingQueue(socketId: string): boolean {
    const index = this.waitingQueue.indexOf(socketId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
      return true;
    }
    return false;
  }

  public getNextWaitingUser(): string | null {
    return this.waitingQueue.shift() || null;
  }

  public createPartnership(socket1Id: string, socket2Id: string): string | null {
    try {
      const roomId = `room_${++this.roomCounter}`;

      this.partnerships.set(socket1Id, socket2Id);
      this.partnerships.set(socket2Id, socket1Id);

      this.rooms.set(roomId, {
        participants: [socket1Id, socket2Id],
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        connectionStatus: 'connecting'
      });

      const user1 = this.users.get(socket1Id);
      const user2 = this.users.get(socket2Id);

      if (user1 && user2) {
        user1.inCall = true;
        user2.inCall = true;
        user1.room = roomId;
        user2.room = roomId;
      }

      return roomId;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error creating partnership:`, error);
      return null;
    }
  }

  public breakPartnership(socketId: string): string | null {
    try {
      const partnerId = this.partnerships.get(socketId);
      if (partnerId) {
        const user = this.users.get(socketId);
        const partnerUser = this.users.get(partnerId);

        if (user && user.room) {
          this.rooms.delete(user.room);
        }

        [user, partnerUser].forEach(u => {
          if (u) {
            u.inCall = false;
            u.room = null;
          }
        });

        this.partnerships.delete(socketId);
        this.partnerships.delete(partnerId);
        return partnerId;
      }
      return null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error breaking partnership:`, error);
      return null;
    }
  }

  public validatePeers(fromPeerId: string, toPeerId: string): { roomId: string; participants: string[] } | null {
    try {
      for (const [roomId, room] of this.rooms) {
        if (room.participants.includes(fromPeerId) && room.participants.includes(toPeerId)) {
          return { roomId, participants: room.participants };
        }
      }
      return null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error validating peers:`, error);
      return null;
    }
  }

  public getConnectionStats(): ConnectionStats {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }

  public getRoomByParticipant(socketId: string): string | null {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.includes(socketId)) {
        return roomId;
      }
    }
    return null;
  }

  public getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }
}