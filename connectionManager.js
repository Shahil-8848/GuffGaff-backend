class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
  }

  addUser(socketId) {
    this.users.set(socketId, {
      id: socketId,
      inCall: false,
      room: null,
      joinedAt: new Date().toISOString(),
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
    if (index !== -1) {
      this.waitingQueue.splice(index, 1);
      return true;
    }
    return false;
  }

  createPartnership(socket1Id, socket2Id) {
    const roomId = `room_${++this.roomCounter}`;

    // Create room first
    this.rooms.set(roomId, {
      id: roomId,
      participants: [socket1Id, socket2Id],
      createdAt: new Date().toISOString(),
    });

    // Then set up partnerships
    this.partnerships.set(socket1Id, socket2Id);
    this.partnerships.set(socket2Id, socket1Id);

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

  breakPartnership(socketId) {
    const partnerId = this.partnerships.get(socketId);
    if (partnerId) {
      const user = this.users.get(socketId);
      const partnerUser = this.users.get(partnerId);

      if (user && user.room) {
        this.rooms.delete(user.room);
      }

      if (user) {
        user.inCall = false;
        user.room = null;
      }
      if (partnerUser) {
        partnerUser.inCall = false;
        partnerUser.room = null;
      }

      this.partnerships.delete(socketId);
      this.partnerships.delete(partnerId);
      return partnerId;
    }
    return null;
  }

  findRoomByPeerId(peerId) {
    const user = this.users.get(peerId);
    if (!user || !user.room) return null;

    const room = this.rooms.get(user.room);
    if (!room) return null;

    return {
      id: room.id,
      participants: room.participants,
    };
  }

  getStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }
}

module.exports = ConnectionManager;
