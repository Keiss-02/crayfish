 #include <OneWire.h>
#include <DallasTemperature.h>

// ================= PINS — SENSORS (INPUT) =================
#define TURBIDITY_PIN     34   // Turbidity sensor analog output
#define DS18B20_PIN       15   // DS18B20 temperature sensor data line
#define FLOW_PIN          27   // Flow sensor pulse output (interrupt)
#define MQ137_PIN         35   // MQ-137 ammonia sensor analog output

// ================= PINS — ACTUATORS (OUTPUT) =================
#define UV_RELAY_PIN      4    // Relay: UV sterilizer lamp
#define SOLENOID_RELAY_PIN 14  // Relay: solenoid water valve
#define FAN_PIN           21   // Cooling fan for Peltier module
#define RPWM              16   // Peltier driver PWM (direction A)
#define LPWM              17   // Peltier driver PWM (direction B)
#define R_EN              18   // Peltier driver enable (right)
#define L_EN              19   // Peltier driver enable (left)
#define PUMP_RELAY_PIN    26   // Relay: submersible pump (Active LOW)

// ================= PINS — STEPPER MOTOR (A4988) =================
// DIR moved from 14→2 to avoid conflict with SOLENOID_RELAY_PIN
#define STEP_PIN          12   // A4988 STEP
#define DIR_PIN            2   // A4988 DIR  (was 14, now 2)
#define ENABLE_PIN        13   // A4988 ENABLE (LOW = enabled)

// MS1=3.3V, MS2=3.3V, MS3=GND → 1/8 microstepping (wire directly, no pin needed)

// ================= STEPPER CONFIG =================
int stepDelay = 2000;          // microseconds between pulses (controls speed)

// ================= AMMONIA / PUMP =================
const int AMMONIA_PUMP_THRESHOLD = 2000;
String pumpState = "OFF";

// ================= DS18B20 =================
OneWire oneWire(DS18B20_PIN);
DallasTemperature sensors(&oneWire);

// ================= FLOW SENSOR =================
volatile int pulseCount  = 0;
float flowRate            = 0.0;
float totalLiters         = 0.0;
unsigned long oldTime     = 0;
unsigned long lastFlowTime = 0;
bool valveOpen            = false;
const unsigned long noFlowTimeout = 5000;

// ================= SHARED VARIABLES =================
int    turbidityThreshold = 2000;
int    turbidityValue;
int    ammoniaValue;
String ammoniaStatus;
float  temperatureC;
String uvState      = "OFF";
String peltierState = "OFF";

// ================= INTERRUPT =================
void IRAM_ATTR pulseCounter() {
  pulseCount++;
}

// ================= VALVE CONTROL =================
void openValve() {
  if (!valveOpen) {
    digitalWrite(SOLENOID_RELAY_PIN, HIGH);
    valveOpen = true;
  }
}
void closeValve() {
  if (valveOpen) {
    digitalWrite(SOLENOID_RELAY_PIN, LOW);
    valveOpen = false;
  }
}

// ================= PELTIER CONTROL =================
void peltierON(int power) {
  analogWrite(RPWM, power);
  analogWrite(LPWM, 0);
  digitalWrite(FAN_PIN, HIGH);
  peltierState = "ON";
}
void peltierOFF() {
  analogWrite(RPWM, 0);
  analogWrite(LPWM, 0);
  digitalWrite(FAN_PIN, LOW);
  peltierState = "OFF";
}

// ================= PUMP CONTROL =================
void pumpON() {
  digitalWrite(PUMP_RELAY_PIN, LOW);
  pumpState = "ON";
}
void pumpOFF() {
  digitalWrite(PUMP_RELAY_PIN, HIGH);
  pumpState = "OFF";
}

// ================= STEPPER MOTOR =================
void runMotor(int steps, bool clockwise) {
  digitalWrite(DIR_PIN,    clockwise ? HIGH : LOW);
  digitalWrite(ENABLE_PIN, LOW);    // Enable A4988

  for (int i = 0; i < steps; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(stepDelay);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(stepDelay);
  }

  digitalWrite(ENABLE_PIN, HIGH);   // Disable after move (reduces heat)
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  // ---- INPUT SENSORS ----
  pinMode(TURBIDITY_PIN, INPUT);
  pinMode(MQ137_PIN,     INPUT);
  pinMode(FLOW_PIN,      INPUT_PULLUP);

  // ---- OUTPUT ACTUATORS ----
  pinMode(UV_RELAY_PIN,       OUTPUT);
  pinMode(SOLENOID_RELAY_PIN, OUTPUT);
  pinMode(FAN_PIN,            OUTPUT);
  pinMode(PUMP_RELAY_PIN,     OUTPUT);
  pinMode(RPWM,               OUTPUT);
  pinMode(LPWM,               OUTPUT);
  pinMode(R_EN,               OUTPUT);
  pinMode(L_EN,               OUTPUT);

  // ---- STEPPER PINS ----
  pinMode(STEP_PIN,   OUTPUT);
  pinMode(DIR_PIN,    OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  // ---- INITIAL STATES ----
  digitalWrite(UV_RELAY_PIN,       HIGH);  // UV OFF  (Active LOW relay)
  digitalWrite(SOLENOID_RELAY_PIN, LOW);   // Valve CLOSED
  digitalWrite(FAN_PIN,            LOW);   // Fan OFF
  digitalWrite(PUMP_RELAY_PIN,     HIGH);  // Pump OFF (Active LOW relay)
  digitalWrite(R_EN,               HIGH);  // Enable Peltier driver
  digitalWrite(L_EN,               HIGH);
  digitalWrite(ENABLE_PIN,         HIGH);  // Stepper disabled at startup

  // ---- FLOW INTERRUPT ----
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);

  // ---- DS18B20 ----
  sensors.begin();

  Serial.println("=================================");
  Serial.println(" FULL SMART WATER SYSTEM ONLINE ");
  Serial.println("  + STEPPER FEEDER READY        ");
  Serial.println("=================================");
}

// ================= LOOP =================
void loop() {
  unsigned long currentTime = millis();

  // ========== TURBIDITY SENSOR ==========
  turbidityValue = analogRead(TURBIDITY_PIN);
  String waterStatus = (turbidityValue > turbidityThreshold) ? "CLOUDY" : "CLEAR";

  // ========== AMMONIA SENSOR ==========
  ammoniaValue = analogRead(MQ137_PIN);
  if      (ammoniaValue > 2000) ammoniaStatus = "HIGH NH3";
  else if (ammoniaValue > 1200) ammoniaStatus = "MODERATE";
  else                           ammoniaStatus = "LOW";

  // ========== PUMP — driven by ammonia ==========
  if (ammoniaValue > AMMONIA_PUMP_THRESHOLD) pumpON();
  else                                        pumpOFF();

  // ========== TEMPERATURE SENSOR ==========
  sensors.requestTemperatures();
  temperatureC = sensors.getTempCByIndex(0);

  // ========== PELTIER — driven by temperature ==========
  if      (temperatureC > 30) peltierON(200);
  else if (temperatureC < 27) peltierOFF();

  // ========== FLOW SENSOR + SOLENOID VALVE ==========
  if (currentTime - oldTime >= 1000) {
    detachInterrupt(digitalPinToInterrupt(FLOW_PIN));
    flowRate = ((1000.0 / (currentTime - oldTime)) * pulseCount) / 7.5;
    if (pulseCount > 0) {
      lastFlowTime = currentTime;
      openValve();
    }
    if (flowRate > 0) totalLiters += (flowRate / 60.0);
    if (currentTime - lastFlowTime > noFlowTimeout) {
      totalLiters = 0;
      closeValve();
    }
    oldTime    = currentTime;
    pulseCount = 0;
    attachInterrupt(digitalPinToInterrupt(FLOW_PIN), pulseCounter, FALLING);

    // ========== SERIAL STATUS OUTPUT ==========
    Serial.print("TURBIDITY:");   Serial.print(turbidityValue);
    Serial.print(" | WATER:");    Serial.print(waterStatus);
    Serial.print(" | TEMP:");     Serial.print(temperatureC);
    Serial.print(" | FLOW:");     Serial.print(flowRate, 2);
    Serial.print("L/min | TOTAL:"); Serial.print(totalLiters, 3);
    Serial.print("L | VALVE:");   Serial.print(valveOpen ? "OPEN" : "CLOSED");
    Serial.print(" | NH3:");      Serial.print(ammoniaValue);
    Serial.print(" | AIR:");      Serial.print(ammoniaStatus);
    Serial.print(" | PUMP:");     Serial.print(pumpState);
    Serial.print(" | UV:");       Serial.print(uvState);
    Serial.print(" | PELTIER:");  Serial.println(peltierState);
  }

  // ========== SERIAL COMMANDS ==========
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    // ---- Water system commands ----
    if (cmd == "UV_ON")    { digitalWrite(UV_RELAY_PIN, LOW);  uvState = "ON";  }
    if (cmd == "UV_OFF")   { digitalWrite(UV_RELAY_PIN, HIGH); uvState = "OFF"; }
    if (cmd == "VALVE_ON")   openValve();
    if (cmd == "VALVE_OFF")  closeValve();
    if (cmd == "COOL_MAX")   peltierON(255);
    if (cmd == "COOL_OFF")   peltierOFF();
    if (cmd == "PUMP_ON")    pumpON();
    if (cmd == "PUMP_OFF")   pumpOFF();

    // ---- Stepper commands ----
    // PING           → replies PONG (used by Python at startup)
    // MOVE <n> <CW|CCW> → runs motor n steps in direction
    // SPEED <us>     → sets step delay in microseconds
    if (cmd == "PING") {
      Serial.println("PONG");
    }
    else if (cmd.startsWith("MOVE ")) {
      int    firstSpace  = cmd.indexOf(' ');
      int    secondSpace = cmd.indexOf(' ', firstSpace + 1);
      int    steps       = cmd.substring(firstSpace + 1, secondSpace).toInt();
      String dirStr      = cmd.substring(secondSpace + 1);
      dirStr.trim();
      bool   clockwise   = (dirStr == "CW");

      Serial.print("Moving "); Serial.print(steps);
      Serial.print(" steps "); Serial.println(dirStr);
      runMotor(steps, clockwise);
      Serial.println("DONE");
    }
    else if (cmd.startsWith("SPEED ")) {
      stepDelay = cmd.substring(6).toInt();
      Serial.print("Speed set: "); Serial.print(stepDelay); Serial.println("us");
    }
  }
}