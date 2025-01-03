class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.roomCounter = 0;
  }
  createRoom(participants) {
    const roomId = `room_${++this.roomCounter}_${Date.now()}`;
    this.rooms.set(roomId, {
      participants,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      messages: [],
      connected: false,
      connectionAttempts: 0,
      maxRetries: 3,
    });
    return roomId;
  }
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }
  updateRoomStatus(roomId, status) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.connected = status;
      room.lastActivity = new Date().toISOString();
      if (status) {
        room.connectionAttempts++;
      }
    }
  }
  removeRoom(roomId) {
    this.rooms.delete(roomId);
  }
  getRoomByParticipant(participantId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.includes(participantId)) {
        return roomId;
      }
    }
    return null;
  }
  getActiveRooms() {
    return Array.from(this.rooms.entries())
      .filter(([_, room]) => room.connected)
      .map(([roomId]) => roomId);
  }
}
module.exports = RoomManager;
