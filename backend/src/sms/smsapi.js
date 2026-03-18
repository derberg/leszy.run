const SMSAPI_URL = 'https://api.smsapi.pl/sms.do'

export async function sendSms(phone, message) {
  const token = process.env.SMSAPI_TOKEN
  const sender = process.env.SMSAPI_SENDER || 'LeszyRun'
  if (!token) return { success: false, error: 'SMSAPI_TOKEN not configured' }

  const params = new URLSearchParams({
    to: phone.replace(/\s+/g, ''), message, from: sender, format: 'json', encoding: 'utf-8',
  })

  const res = await fetch(SMSAPI_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const data = await res.json()
  if (data.error) return { success: false, error: `${data.error}: ${data.message || ''}` }
  return { success: true, messageId: data.list?.[0]?.id }
}
