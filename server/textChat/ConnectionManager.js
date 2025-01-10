const { getFirestore } = require("firebase-admin/firestore");
class TextChatConnectionManager {
  constructor() {
    this.users = new Map();
    this.matches = new Map();
    this.waitingQueue = [];
    this.db = getFirestore();
  }
  addUser(socketId, userData) {
    if (!this.users.has(socketId)) {
      this.users.set(socketId, {
        ...userData,
        status: "online",
        isMatching: false,
        matchId: null,
        lastActive: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }
  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user && user.matchId) {
      this.breakMatch(socketId);
    }
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
  }
  addToWaitingQueue(socketId) {
    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      const user = this.users.get(socketId);
      if (user) {
        user.isMatching = true;
      }
      return true;
    }
    return false;
  }
  removeFromWaitingQueue(socketId) {
    const index = this.waitingQueue.indexOf(socketId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
      const user = this.users.get(socketId);
      if (user) {
        user.isMatching = false;
      }
      return true;
    }
    return false;
  }
  async createMatch(socket1Id, socket2Id) {
    try {
      const user1 = this.users.get(socket1Id);
      const user2 = this.users.get(socket2Id);
      if (!user1 || !user2) return null;
      const matchId = `match_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      // Get Firestore data for both users
      const [user1Data, user2Data] = await Promise.all([
        this.db.collection("users").doc(user1.firestoreId).get(),
        this.db.collection("users").doc(user2.firestoreId).get(),
      ]);
      const match = {
        id: matchId,
        participants: [
          {
            socketId: socket1Id,
            firestoreId: user1.firestoreId,
            userData: user1Data.data(),
          },
          {
            socketId: socket2Id,
            firestoreId: user2.firestoreId,
            userData: user2Data.data(),
          },
        ],
        status: "pending",
        createdAt: new Date().toISOString(),
        messages: [],
      };
      this.matches.set(matchId, match);
      user1.matchId = matchId;
      user2.matchId = matchId;
      return match;
    } catch (error) {
      console.error("Error creating match:", error);
      return null;
    }
  }
  confirmMatch(matchId, socketId) {
    const match = this.matches.get(matchId);
    if (!match) return false;
    const participant = match.participants.find((p) => p.socketId === socketId);
    if (!participant) return false;
    participant.confirmed = true;
    // Check if both participants confirmed
    const allConfirmed = match.participants.every((p) => p.confirmed);
    if (allConfirmed) {
      match.status = "active";
    }
    return allConfirmed;
  }
  breakMatch(socketId) {
    const user = this.users.get(socketId);
    if (!user || !user.matchId) return null;
    const match = this.matches.get(user.matchId);
    if (!match) return null;
    // Get the other participant
    const otherParticipant = match.participants.find(
      (p) => p.socketId !== socketId
    );

    // Clean up match data
    this.matches.delete(user.matchId);

    // Clean up user states
    match.participants.forEach((p) => {
      const user = this.users.get(p.socketId);
      if (user) {
        user.matchId = null;
        user.isMatching = false;
      }
    });
    return otherParticipant?.socketId;
  }
  addMessage(matchId, message) {
    const match = this.matches.get(matchId);
    if (!match) return false;
    match.messages.push({
      ...message,
      timestamp: new Date().toISOString(),
    });
    return true;
  }
  getStats() {
    return {
      totalUsers: this.users.size,
      activeMatches: Array.from(this.matches.values()).filter(
        (m) => m.status === "active"
      ).length,
      waitingUsers: this.waitingQueue.length,
    };
  }
}
module.exports = TextChatConnectionManager;
