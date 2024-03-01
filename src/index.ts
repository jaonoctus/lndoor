import express from 'express'
import bunyan from 'bunyan'
import { PrismaClient } from '@prisma/client'
import {
  CreateInvoiceResult,
  GetInvoiceResult,
  authenticatedLndGrpc,
  createInvoice,
  subscribeToInvoice
} from 'lightning'
import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const PORT = 3001
const OPEN_DOOR_SIGNAL = '1'
const CLOSE_DOOR_SIGNAL = '0'

const configSchema = z.object({
  PORT: z.coerce.number().nullable().default(3001),
  INVOICE_PRICE: z.coerce.number().int().nullable().default(21_000),
  LND_HOST: z.string(),
  LND_CERT: z.string(),
  LND_MACAROON: z.string(),
  DATABASE_URL: z.string().default('file:./dev.db'),
})

const config = configSchema.parse(process.env)

const app = express()
const prisma = new PrismaClient()

const { lnd } = authenticatedLndGrpc({
  socket: config.LND_HOST,
  cert: config.LND_CERT,
  macaroon: config.LND_MACAROON
})

app.get('/open-sesame', async (req, res) => {
  const log = bunyan.createLogger({ name: 'open-sesame' })

  const agent = req.headers['user-agent']
  log.info({ agent }, 'Open sesame request received')

  const pendingOpenSesame = await prisma.openSesame.findMany({
    where: {
      openedAt: null
    }
  })

  log.info({ count: pendingOpenSesame.length }, 'Pending open sesame requests')

  if (pendingOpenSesame.length === 0) {
    res.send(CLOSE_DOOR_SIGNAL)
    return
  }

  log.info('Opening the door')

  await prisma.openSesame.updateMany({
    where: {
      id: {
        in: pendingOpenSesame.map((openSesame) => openSesame.id)
      }
    },
    data: {
      openedAt: new Date()
    }
  })

  res.send(OPEN_DOOR_SIGNAL)
})

app.get('/invoice', async (req, res) => {
  const log = bunyan.createLogger({ name: 'invoice' })

  log.info('Invoice request received')

  const pendingOpenSesame = await prisma.openSesame.count({
    where: {
      openedAt: null
    }
  })

  log.info({ count: pendingOpenSesame }, 'Pending open sesame requests')

  if (pendingOpenSesame > 0) {
    res.status(400).json({
      error: 'There is already a pending open sesame request'
    })
    return
  }

  let invoice: CreateInvoiceResult

  try {
    log.info('Creating invoice')
    invoice = await createInvoice({
      lnd,
      tokens: config.INVOICE_PRICE
    })
  } catch (error) {
    log.error({ error }, 'Failed to create invoice')
    res.status(500).json({
      error: 'Failed to create invoice'
    })
    return
  }

  log.info({ invoice }, 'Waiting for payment')

  const sub = subscribeToInvoice({
    lnd,
    id: invoice.id,
  }).on('invoice_updated', async (data: GetInvoiceResult) => {
    if (data.is_confirmed) {
      log.info('Payment received')
      await prisma.openSesame.create({
        data: {
          invoiceId: data.id,
        }
      })
      sub.removeAllListeners()
      return
    }

    if (data.is_canceled) {
      log.info('Payment expired or canceled')
      sub.removeAllListeners()
      return
    }
  })

  log.info({ request: invoice.request }, 'Invoice created')

  res.json({
    invoice: invoice.request
  })
})

app.listen(PORT, () => {
  const log = bunyan.createLogger({ name: 'server' })
  log.info({ port: PORT }, 'Server started')
})
