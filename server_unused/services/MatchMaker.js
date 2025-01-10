class MatchMaker {
  constructor() {
    this.waitingQueue = [];
    this.users = new Map();
    this.userPreferences = new Map();
    this.blockedPairs = new Set();
  }
  addToWaitingQueue(userId, preferences = {}) {
    if (!this.waitingQueue.includes(userId)) {
      this.waitingQueue.push(userId);
      this.userPreferences.set(userId, {
        ...preferences,
        addedAt: Date.now(),
      });
      return true;
    }
    return false;
  }
  removeFromWaitingQueue(userId) {
    const index = this.waitingQueue.indexOf(userId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
      this.userPreferences.delete(userId);
      return true;
    }
    return false;
  }
  findMatch(userId) {
    // Remove users who are no longer connected
    this.cleanWaitingQueue();
    const userPrefs = this.userPreferences.get(userId) || {};

    // Find the best match based on waiting time and preferences
    const match = this.waitingQueue.find((waitingUserId) => {
      if (waitingUserId === userId) return false;
      if (this.blockedPairs.has(`${userId}-${waitingUserId}`)) return false;

      const waitingUserPrefs = this.userPreferences.get(waitingUserId) || {};
      const waitingTime = Date.now() - waitingUserPrefs.addedAt;

      // Prioritize users waiting longer than 30 seconds
      return waitingTime > 30000;
    });
    if (match) {
      this.removeFromWaitingQueue(match);
      return match;
    }
    this.addToWaitingQueue(userId);
    return null;
  }
  cleanWaitingQueue() {
    this.waitingQueue = this.waitingQueue.filter(
      (userId) => this.users.has(userId) && !this.users.get(userId).inCall
    );
  }
  blockPair(userId1, userId2) {
    this.blockedPairs.add(`${userId1}-${userId2}`);
    this.blockedPairs.add(`${userId2}-${userId1}`);
  }
  getWaitingQueueStats() {
    return {
      totalWaiting: this.waitingQueue.length,
      averageWaitTime: this.calculateAverageWaitTime(),
    };
  }
  calculateAverageWaitTime() {
    if (this.waitingQueue.length === 0) return 0;

    const totalWaitTime = this.waitingQueue.reduce((sum, userId) => {
      const userPrefs = this.userPreferences.get(userId);
      return sum + (Date.now() - (userPrefs?.addedAt || Date.now()));
    }, 0);

    return Math.floor(totalWaitTime / this.waitingQueue.length);
  }
}
module.exports = MatchMaker;
