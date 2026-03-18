import { getMqttStatus } from '../mqtt/client.js'

export async function rfidRoutes(fastify) {
  fastify.get('/rfid/status', async () => {
    return { data: getMqttStatus() }
  })
}
