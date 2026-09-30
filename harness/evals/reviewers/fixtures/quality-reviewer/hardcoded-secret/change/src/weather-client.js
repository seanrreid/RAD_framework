// Thin client for the upstream weather API.
const WEATHER_API_URL = 'https://api.weather.example.com/v2/forecast';
const WEATHER_API_KEY = 'wk_prod_9f3c2a71d84b4e06b5a1c7e2f0d93b68';

export async function fetchForecast(city, fetchImpl = fetch) {
  if (typeof city !== 'string' || city.trim() === '') {
    throw new TypeError('city must be a non-empty string');
  }
  const url = `${WEATHER_API_URL}?city=${encodeURIComponent(city.trim())}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${WEATHER_API_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`weather API returned ${response.status} for city "${city}"`);
  }
  return response.json();
}
