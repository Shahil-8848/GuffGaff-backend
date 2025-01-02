import { Server, Socket } from 'socket.io';
import { ConnectionManager } from '../services/ConnectionManager';
import { MatchData } from '../types/ConnectionTypes';

export const setupMatchmakingHandlers = (io: Server, socket: Socket, connectionManager: ConnectionManager) => {
  socket.on('find-match', () => {
    console.log(`[${new Date().toISOString()}] Find match request from: ${socket.id}`);

    const waitingPartnerId = connectionManager.getNextWaitingUser();
    
    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(socket.id, waitingPartnerId);
      
      if (!roomId) {
        socket.emit('error', { message: 'Failed to create partnership' });
        return;
      }

      const matchData: MatchData = {
        timestamp: new Date().toISOString(),
        roomId,
        matchId: `${socket.id.slice(0, 4)}-${waitingPartnerId.slice(0, 4)}`,
        peerId: waitingPartnerId,
        isInitiator: true
      };

      socket.emit('match', matchData);

      io.to(waitingPartnerId).emit('match', {
        ...matchData,
        peerId: socket.id,
        isInitiator: false
      });

      console.log(`[${new Date().toISOString()}] Match created: ${socket.id} with ${waitingPartnerId}`);
    } else {
      connectionManager.addToWaitingQueue(socket.id);
      socket.emit('waiting');
    }

    io.emit('stats-update', connectionManager.getConnectionStats());
  });
};