class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
    this.connectionTimeouts = new Map();
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = 30000;
  }
  addUser(socketId, userId) {
    this.users.set(socketId, {
      userId,
      inCall: false,
      room: null,
      connectedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    });
  }
  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user && user.room) {
      this.breakPartnership(socketId);
    }
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
  }
  addToWaitingQueue(socketId) {
    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      return true;
    }
    return false;
  }
  removeFromWaitingQueue(socketId) {
    const index = this.waitingQueue.indexOf(socketId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
      return true;
    }
    return false;
  }
  getNextWaitingUser() {
    if (this.waitingQueue.length > 0) {
      return this.waitingQueue.shift();
    }
    return null;
  }
  createPartnership(socket1Id, socket2Id) {
    const roomId = `room_${++this.roomCounter}`;
    this.partnerships.set(socket1Id, socket2Id);
    this.partnerships.set(socket2Id, socket1Id);
    this.rooms.set(roomId, {
      participants: [socket1Id, socket2Id],
      createdAt: new Date().toISOString(),
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
  }
  findRoomByPeerId(peerId) {
    for (const [roomId, room] of this.rooms) {
      if (room.participants.includes(peerId)) {
        return { roomId, participants: room.participants };
      }
    }
    return null;
  }
  breakPartnership(socketId) {
    const partnerId = this.partnerships.get(socketId);
    if (partnerId) {
      const user = this.users.get(socketId);
      const partnerUser = this.users.get(partnerId);

      if (user && user.room) {
        if (this.connectionTimeouts.has(user.room)) {
          clearTimeout(this.connectionTimeouts.get(user.room));
          this.connectionTimeouts.delete(user.room);
        }
        this.rooms.delete(user.room);
      }
      // Clean up user states
      [user, partnerUser].forEach((u) => {
        if (u) {
          u.inCall = false;
          u.room = null;
          u.signalingState = "new";
        }
      });
      // Remove partnerships
      this.partnerships.delete(socketId);
      this.partnerships.delete(partnerId);
      return partnerId;
    }
    return null;
  }
  getConnectionStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }
  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActive = new Date().toISOString();
    }
  }
  validatePeers(fromPeerId, toPeerId) {
    const room = this.findRoomByPeerId(fromPeerId);
    if (!room) return null;

    const otherParticipant = room.participants.find((p) => p !== fromPeerId);
    if (otherParticipant !== toPeerId) return null;

    return room;
  }
}
module.exports = ConnectionManager;
