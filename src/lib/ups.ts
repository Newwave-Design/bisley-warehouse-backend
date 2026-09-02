type UpsAddress = {
  name: string
  attentionName?: string | null
  phone?: string | null
  email?: string | null
  addressLine1: string
  addressLine2?: string | null
  city: string
  stateProvinceCode?: string | null
  postalCode: string
  countryCode: string
}

type UpsPackage = {
  description: string
  weightKg: number
  lengthCm?: number | null
  widthCm?: number | null
  heightCm?: number | null
}

export type UpsShipmentInput = {
  serviceCode: string
  serviceDescription: string
  shipTo: UpsAddress
  shipFrom?: Partial<UpsAddress>
  package: UpsPackage
  customerContext: string
}

type UpsToken = {
  accessToken: string
  expiresAt: number
}

let tokenCache: UpsToken | null = null

const UPS_SERVICE_CODE_MAP: Record<string, string> = {
  ups_standard: '11',
  ups_express: '65',
  ups_express_worldwide: '07',
  ups_express_plus: '54',
  ups_expedited: '08',
  ups_express_freight: '96',
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required UPS env var: ${name}`)
  return value
}

function getUpsBaseUrl(): string {
  const environment = (process.env.UPS_ENVIRONMENT ?? 'test').toLowerCase()
  return environment === 'production' ? 'https://onlinetools.ups.com' : 'https://wwwcie.ups.com'
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

function cleanPhone(value?: string | null): string | undefined {
  if (!value) return undefined
  const digits = value.replace(/[^\d]/g, '')
  return digits || undefined
}

function toAddressPayload(address: UpsAddress) {
  return {
    Name: address.name.slice(0, 35),
    AttentionName: (address.attentionName ?? address.name).slice(0, 35),
    Phone: address.phone ? { Number: address.phone.slice(0, 15) } : undefined,
    EMailAddress: address.email ?? undefined,
    Address: {
      AddressLine: [address.addressLine1, address.addressLine2].filter(Boolean).slice(0, 2),
      City: address.city,
      StateProvinceCode: address.stateProvinceCode ?? undefined,
      PostalCode: address.postalCode.replace(/\s+/g, ''),
      CountryCode: address.countryCode.toUpperCase(),
    },
  }
}

function resolveServiceCode(serviceCode: string): string {
  return UPS_SERVICE_CODE_MAP[serviceCode] ?? serviceCode
}

export async function getUpsAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken
  }

  const clientId = requireEnv('UPS_CLIENT_ID')
  const clientSecret = requireEnv('UPS_CLIENT_SECRET')
  const merchantId = process.env.UPS_ACCOUNT_NUMBER

  const response = await fetch(`${getUpsBaseUrl()}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })

  const data: any = await response.json().catch(() => ({}))
  if (!response.ok || !data?.access_token) {
    const message = data?.response?.errors?.map((error: { message?: string }) => error.message).filter(Boolean).join('; ')
      || data?.error_description
      || `UPS OAuth failed with status ${response.status}`
    throw new Error(message)
  }

  const expiresInMs = Math.max(60, parseInt(data.expires_in ?? '3600', 10) - 60) * 1000
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  }

  return data.access_token
}

export async function createUpsShipmentLabel(input: UpsShipmentInput) {
  const accountNumber = requireEnv('UPS_ACCOUNT_NUMBER')
  const token = await getUpsAccessToken()
  const shipperName = requireEnv('UPS_SHIPPER_NAME')
  const shipperAttention = process.env.UPS_SHIPPER_ATTENTION_NAME ?? shipperName
  const shipperPhone = cleanPhone(requireEnv('UPS_SHIPPER_PHONE'))
  const shipperEmail = process.env.UPS_SHIPPER_EMAIL ?? undefined
  const shipmentVersion = process.env.UPS_SHIP_API_VERSION ?? 'v2403'

  const shipFrom: UpsAddress = {
    name: input.shipFrom?.name ?? shipperName,
    attentionName: input.shipFrom?.attentionName ?? shipperAttention,
    phone: cleanPhone(input.shipFrom?.phone ?? shipperPhone),
    email: input.shipFrom?.email ?? shipperEmail,
    addressLine1: input.shipFrom?.addressLine1 ?? requireEnv('UPS_SHIPPER_ADDRESS_1'),
    addressLine2: input.shipFrom?.addressLine2 ?? process.env.UPS_SHIPPER_ADDRESS_2 ?? undefined,
    city: input.shipFrom?.city ?? requireEnv('UPS_SHIPPER_CITY'),
    stateProvinceCode: input.shipFrom?.stateProvinceCode ?? process.env.UPS_SHIPPER_STATE_PROVINCE_CODE ?? undefined,
    postalCode: input.shipFrom?.postalCode ?? requireEnv('UPS_SHIPPER_POSTAL_CODE'),
    countryCode: input.shipFrom?.countryCode ?? requireEnv('UPS_SHIPPER_COUNTRY_CODE'),
  }

  const response = await fetch(`${getUpsBaseUrl()}/api/shipments/${shipmentVersion}/ship`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      transId: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
      transactionSrc: 'bisley-wms',
    },
    body: JSON.stringify({
      ShipmentRequest: {
        Request: {
          RequestOption: 'nonvalidate',
          SubVersion: '2205',
          TransactionReference: {
            CustomerContext: input.customerContext.slice(0, 512),
          },
        },
        Shipment: {
          Description: input.package.description.slice(0, 50),
          Shipper: {
            ...toAddressPayload(shipFrom),
            ShipperNumber: accountNumber,
          },
          ShipFrom: toAddressPayload(shipFrom),
          ShipTo: toAddressPayload({
            ...input.shipTo,
            phone: cleanPhone(input.shipTo.phone),
          }),
          PaymentInformation: {
            ShipmentCharge: {
              Type: '01',
              BillShipper: {
                AccountNumber: accountNumber,
              },
            },
          },
          Service: {
            Code: resolveServiceCode(input.serviceCode),
            Description: input.serviceDescription,
          },
          Package: [
            {
              Description: input.package.description.slice(0, 35),
              Packaging: { Code: '02' },
              Dimensions: input.package.lengthCm && input.package.widthCm && input.package.heightCm
                ? {
                    UnitOfMeasurement: { Code: 'CM' },
                    Length: String(Math.max(1, Math.round(input.package.lengthCm))),
                    Width: String(Math.max(1, Math.round(input.package.widthCm))),
                    Height: String(Math.max(1, Math.round(input.package.heightCm))),
                  }
                : undefined,
              PackageWeight: {
                UnitOfMeasurement: { Code: 'KGS' },
                Weight: input.package.weightKg.toFixed(2),
              },
            },
          ],
        },
        LabelSpecification: {
          LabelImageFormat: {
            Code: 'GIF',
            Description: 'GIF',
          },
          HTTPUserAgent: 'Mozilla/5.0',
        },
      },
    }),
  })

  const data: any = await response.json().catch(() => ({}))
  const shipmentResponse = data?.ShipmentResponse
  const shipmentResults = shipmentResponse?.ShipmentResults
  const packageResults = Array.isArray(shipmentResults?.PackageResults)
    ? shipmentResults.PackageResults[0]
    : shipmentResults?.PackageResults

  if (!response.ok || shipmentResponse?.Response?.ResponseStatus?.Code !== '1' || !packageResults?.TrackingNumber) {
    const alerts = shipmentResponse?.Response?.Alert ?? data?.response?.errors ?? []
    const alertMessages = Array.isArray(alerts)
      ? alerts.map((alert: { Description?: string; message?: string }) => alert.Description ?? alert.message).filter(Boolean).join('; ')
      : ''
    throw new Error(alertMessages || `UPS shipment failed with status ${response.status}`)
  }

  return {
    trackingNumber: packageResults.TrackingNumber as string,
    labelFormat: packageResults.ShippingLabel?.ImageFormat?.Code as string | undefined,
    graphicImage: packageResults.ShippingLabel?.GraphicImage as string | undefined,
    htmlImage: packageResults.ShippingLabel?.HTMLImage as string | undefined,
    alerts: shipmentResponse?.Response?.Alert ?? [],
  }
}