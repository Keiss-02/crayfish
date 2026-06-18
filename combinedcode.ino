#include <OneWire.h>
#include <DallasTemperature.h>

// ================= PINS =================
#define TURBIDITY_PIN      34
#define DS18B20_PIN        15
#define FLOW_PIN           27
#define MQ137_PIN          35
#define UV_RELAY_PIN        4
#define SOLENOID_RELAY_PIN 14
#define FAN_PIN            21
#define RPWM               16
#define LPWM               17
#define R_EN               18
#define L_EN               19
#define PUMP_RELAY_PIN     26
#define STEP_PIN           12
#define DIR_PIN             2
#define ENABLE_PIN         13

// ================= STEPPER =================
int stepDelay = 2000;

// ================= MANUAL OVERRIDE FLAGS =================
// When true, sensor-driven automation is DISABLED for that actuator.
// Set to true by manual ON/OFF commands. Reset by RESET_OVERRIDE command.
bool overridePump   = false;
bool overrideUV     = false;
bool overridePeltier= false;
bool overrideValve  = false;

// ================= AMMONIA THRESHOLDS =================
const int AMMONIA_NORMAL   = 5000;  // below this = normal
const int AMMONIA_CRITICAL = 5500;  // above this = critical → pump ON

// ================= STATES =================
String pumpState    = "OFF";
String uvState      = "OFF";
String peltierState = "OFF";

// ================= DS18B20 =================
OneWire oneWire(DS18B20_PIN);
DallasTemperature sensors(&oneWire);

// ================= FLOW =================
volatile int pulseCount   = 0;
float flowRate             = 0.0;
float totalLiters          = 0.0;
unsigned long oldTime      = 0;
unsigned long lastFlowTime = 0;
bool valveOpen             = false;
const unsigned long noFlowTimeout = 5000;

// ================= SHARED =================
int    turbidityThreshold = 2000;
int    turbidityValue;
int    ammoniaValue;
String ammoniaStatus;
float  temperatureC;

// ================= INTERRUPT =================
void IRAM_ATTR pulseCounter() { pulseCount++; }

// ================= VALVE =================
void openValve() {
  if (!valveOpen) { digitalWrite(SOLENOID_RELAY_PIN, HIGH); valveOpen = true; }
}
void closeValve() {
  if (valveOpen)  { digitalWrite(SOLENOID_RELAY_PIN, LOW);  valveOpen = false; }
}

// ================= PELTIER =================
void peltierON(int power) {
  analogWrite(RPWM, power); analogWrite(LPWM, 0);
  digitalWrite(FAN_PIN, HIGH); peltierState = "ON";
}
void peltierOFF() {
  analogWrite(RPWM, 0); analogWrite(LPWM, 0);
  digitalWrite(FAN_PIN, LOW); peltierState = "OFF";
}

// ================= PUMP =================
void pumpON()  { digitalWrite(PUMP_RELAY_PIN, LOW);  pumpState = "ON";  }
void pumpOFF() { digitalWrite(PUMP_RELAY_PIN, HIGH); pumpState = "OFF"; }

// ================= STEPPER =================
void runMotor(int steps, bool clockwise) {
  digitalWrite(DIR_PIN, clockwise ? HIGH : LOW);
  digitalWrite(ENABLE_PIN, LOW);
  for (int i = 0; i < steps; i++) {
    digitalWrite(STEP_PIN, HIGH); delayMicroseconds(stepDelay);
    digitalWrite(STEP_PIN, LOW);  delayMicroseconds(stepDelay);
  }
  digitalWrite(ENABLE_PIN, HIGH);
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  pinMode(TURBIDITY_PIN, INPUT);
  pinMode(MQ137_PIN,     INPUT);
  pinMode(FLOW_PIN,      INPUT_PULLUP);
  pinMode(UV_RELAY_PIN,       OUTPUT);
  pinMode(SOLENOID_RELAY_PIN, OUTPUT);
  pinMode(FAN_PIN,            OUTPUT);
  pinMode(PUMP_RELAY_PIN,     OUTPUT);
  pinMode(RPWM,  OUTPUT); pinMode(LPWM,  OUTPUT);
  pinMode(R_EN,  OUTPUT); pinMode(L_EN,  OUTPUT);
  pinMode(STEP_PIN,   OUTPUT);
  pinMode(DIR_PIN,    OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  digitalWrite(UV_RELAY_PIN,       HIGH); // UV OFF
  digitalWrite(SOLENOID_RELAY_PIN, LOW);  // Valve CLOSED
  digitalWrite(FAN_PIN,            LOW);
  digitalWrite(PUMP_RELAY_PIN,     HIGH); // Pump OFF
  digitalWrite(R_EN,               HIGH);
  digitalWrite(L_EN,               HIGH);
  digitalWrite(ENABLE_PIN,         HIGH); // Stepper disabled

  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);
  sensors.begin();

  Serial.println("=================================");
  Serial.println(" FULL SMART WATER SYSTEM ONLINE ");
  Serial.println("  MANUAL OVERRIDE READY         ");
  Serial.println("=================================");
}

// ================= LOOP =================
void loop() {
  unsigned long currentTime = millis();

  // ── TURBIDITY ──
  turbidityValue = analogRead(TURBIDITY_PIN);
  String waterStatus = (turbidityValue > turbidityThreshold) ? "CLOUDY" : "CLEAR";

  // ── AMMONIA ──
  ammoniaValue = analogRead(MQ137_PIN);
  if      (ammoniaValue > AMMONIA_CRITICAL) ammoniaStatus = "CRITICAL";
  else if (ammoniaValue > AMMONIA_NORMAL)   ammoniaStatus = "HIGH NH3";
  else if (ammoniaValue > 1200)             ammoniaStatus = "MODERATE";
  else                                       ammoniaStatus = "LOW";

  // ── PUMP — sensor driven ONLY if not overridden ──
  if (!overridePump) {
    if (ammoniaValue > AMMONIA_CRITICAL) pumpON();
    else                                  pumpOFF();
  }

  // ── TEMPERATURE ──
  sensors.requestTemperatures();
  temperatureC = sensors.getTempCByIndex(0);

  // ── PELTIER — sensor driven ONLY if not overridden ──
  if (!overridePeltier) {
    if      (temperatureC > 30) peltierON(200);
    else if (temperatureC < 27) peltierOFF();
  }

  // ── FLOW + VALVE ──
  if (currentTime - oldTime >= 1000) {
    detachInterrupt(digitalPinToInterrupt(FLOW_PIN));
    flowRate = ((1000.0 / (currentTime - oldTime)) * pulseCount) / 7.5;

    // Valve auto-control ONLY if not overridden
    if (!overrideValve) {
      if (pulseCount > 0) { lastFlowTime = currentTime; openValve(); }
      if (currentTime - lastFlowTime > noFlowTimeout) { totalLiters = 0; closeValve(); }
    }

    if (flowRate > 0) totalLiters += (flowRate / 60.0);
    oldTime = currentTime; pulseCount = 0;
    attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);

    // ── SERIAL STATUS ──
    Serial.print("TURBIDITY:"); Serial.print(turbidityValue);
    Serial.print(" | WATER:");  Serial.print(waterStatus);
    Serial.print(" | TEMP:");   Serial.print(temperatureC);
    Serial.print(" | FLOW:");   Serial.print(flowRate, 2);
    Serial.print("L/min | TOTAL:"); Serial.print(totalLiters, 3);
    Serial.print("L | VALVE:"); Serial.print(valveOpen ? "OPEN" : "CLOSED");
    Serial.print(" | NH3:");    Serial.print(ammoniaValue);
    Serial.print(" | AIR:");    Serial.print(ammoniaStatus);
    Serial.print(" | PUMP:");   Serial.print(pumpState);
    Serial.print(" | UV:");     Serial.print(uvState);
    Serial.print(" | PELTIER:"); Serial.print(peltierState);
    // Report override flags so Python knows
    Serial.print(" | OVR_PUMP:");    Serial.print(overridePump    ? "1" : "0");
    Serial.print(" | OVR_UV:");      Serial.print(overrideUV      ? "1" : "0");
    Serial.print(" | OVR_PELTIER:"); Serial.print(overridePeltier ? "1" : "0");
    Serial.print(" | OVR_VALVE:");   Serial.println(overrideValve ? "1" : "0");
  }

  // ── SERIAL COMMANDS ──
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    // UV — manual override
    if (cmd == "UV_ON")  { digitalWrite(UV_RELAY_PIN, LOW);  uvState = "ON";  overrideUV = true;  Serial.println("OK:UV_ON");  }
    if (cmd == "UV_OFF") { digitalWrite(UV_RELAY_PIN, HIGH); uvState = "OFF"; overrideUV = true;  Serial.println("OK:UV_OFF"); }

    // VALVE — manual override
    if (cmd == "VALVE_ON")  { openValve();  overrideValve = true;  Serial.println("OK:VALVE_ON");  }
    if (cmd == "VALVE_OFF") { closeValve(); overrideValve = true;  Serial.println("OK:VALVE_OFF"); }

    // PELTIER — manual override
    if (cmd == "COOL_MAX") { peltierON(255); overridePeltier = true;  Serial.println("OK:COOL_MAX"); }
    if (cmd == "COOL_OFF") { peltierOFF();   overridePeltier = true;  Serial.println("OK:COOL_OFF"); }

    // PUMP — manual override
    if (cmd == "PUMP_ON")  { pumpON();  overridePump = true;  Serial.println("OK:PUMP_ON");  }
    if (cmd == "PUMP_OFF") { pumpOFF(); overridePump = true;  Serial.println("OK:PUMP_OFF"); }

    // RESET all overrides — sensors take back control
    if (cmd == "RESET_OVERRIDE") {
      overridePump = false; overrideUV = false;
      overridePeltier = false; overrideValve = false;
      Serial.println("OK:RESET_OVERRIDE");
    }

    // RESET single overrides
    if (cmd == "RESET_PUMP")    { overridePump    = false; Serial.println("OK:RESET_PUMP");    }
    if (cmd == "RESET_UV")      { overrideUV      = false; Serial.println("OK:RESET_UV");      }
    if (cmd == "RESET_PELTIER") { overridePeltier = false; Serial.println("OK:RESET_PELTIER"); }
    if (cmd == "RESET_VALVE")   { overrideValve   = false; Serial.println("OK:RESET_VALVE");   }

    // STEPPER
    if (cmd == "PING") { Serial.println("PONG"); }
    else if (cmd.startsWith("MOVE ")) {
      int fs = cmd.indexOf(' '), ss = cmd.indexOf(' ', fs + 1);
      int steps = cmd.substring(fs + 1, ss).toInt();
      String dirStr = cmd.substring(ss + 1); dirStr.trim();
      bool cw = (dirStr == "CW");
      Serial.print("Moving "); Serial.print(steps); Serial.print(" steps "); Serial.println(dirStr);
      runMotor(steps, cw);
      Serial.println("DONE");
    }
    else if (cmd.startsWith("SPEED ")) {
      stepDelay = cmd.substring(6).toInt();
      Serial.print("Speed set: "); Serial.print(stepDelay); Serial.println("us");
    }
  }
}