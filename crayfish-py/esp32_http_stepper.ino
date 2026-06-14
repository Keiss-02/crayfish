#include <WiFi.h>
#include <WebServer.h>
#include <AccelStepper.h>

// Change these values to match your stepper driver wiring and desired AP credentials.
const char* ap_ssid = "CrayfishESP32";
const char* ap_password = "crayfish123";
const int stepPin = 26;
const int dirPin = 27;
const int enablePin = 14;
const int defaultSteps = 200;

WebServer server(80);
AccelStepper stepper(AccelStepper::DRIVER, stepPin, dirPin);

void handleMove() {
  String dir = server.arg("dir");
  int steps = server.arg("steps").toInt();
  if (steps <= 0) {
    steps = defaultSteps;
  }

  if (dir.equalsIgnoreCase("CCW")) {
    stepper.move(steps);
  } else {
    stepper.move(-steps);
  }

  while (stepper.distanceToGo() != 0) {
    stepper.run();
  }

  server.send(200, "text/plain", "OK");
}

void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(enablePin, OUTPUT);
  digitalWrite(enablePin, LOW);

  stepper.setMaxSpeed(800);
  stepper.setAcceleration(400);

  WiFi.softAP(ap_ssid, ap_password);
  IPAddress ip = WiFi.softAPIP();
  Serial.printf("ESP32 AP started: %s -> %s\n", ap_ssid, ip.toString().c_str());

  server.on("/move", handleMove);
  server.begin();
  Serial.println("HTTP server running on /move");
}

void loop() {
  server.handleClient();
}
